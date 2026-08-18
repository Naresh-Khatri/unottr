pub mod ipc;
mod scope;
mod tray;

use std::collections::HashMap;
use std::env;
use std::path::PathBuf;
use std::sync::Mutex;
use std::thread;

use tauri::{Manager, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tracing::{info, warn};
use unottr_core::media::FfmpegCli;
use unottr_core::{CancelToken, Database, Event, IngestConfig, IngestService, ModelStore, Paths};

use ipc::events;
use ipc::types::Status;

/// Shared handles for the IPC commands.
pub struct AppState {
    pub paths: Paths,
    pub db: Database,
    /// `None` briefly during shutdown once `RunEvent::Exit` has taken it to call
    /// `IngestService::shutdown`. Commands that touch it (retry_job/start_backfill) just
    /// no-op if it's gone rather than erroring — the app is on its way out anyway.
    pub ingest: Mutex<Option<IngestService>>,
    /// `None` when this session has no tray to build onto (see `tray.rs`); `tray_available`
    /// records that fact once, at startup, so commands don't need to re-check the option.
    pub tray: Mutex<Option<tray::Tray>>,
    pub tray_available: bool,
    /// One in-flight cancel token per model tier download.
    pub downloads: Mutex<HashMap<String, CancelToken>>,
    /// (active, total) in-flight jobs, for the tray status line.
    pub jobs: Mutex<(usize, usize)>,
}

fn forward_events(app: tauri::AppHandle, events_rx: std::sync::mpsc::Receiver<Event>) {
    for event in events_rx {
        if let Some(state) = app.try_state::<AppState>() {
            update_job_count(&state, &event);
            if let Ok(guard) = state.tray.lock()
                && let Some(tray) = guard.as_ref()
            {
                let (active, total) = *state.jobs.lock().unwrap_or_else(|e| e.into_inner());
                tray.set_status(active, total);
            }
        }

        let result = match event {
            Event::Discovered { recording_id } => {
                events::recording_discovered(&app, events::RecordingDiscovered { recording_id })
            }
            Event::Progress { recording_id, stage, pct } => events::job_progress(
                &app,
                events::JobProgress { recording_id, stage: Status::parse_lenient(stage.as_str()), pct },
            ),
            Event::Done { recording_id } => events::job_done(&app, events::JobDone { recording_id }),
            Event::Failed { recording_id, error } => {
                events::job_failed(&app, events::JobFailed { recording_id, error })
            }
        };
        if let Err(e) = result {
            warn!(error = %e, "failed to emit ingest event to the webview");
        }
    }
}

/// Worker concurrency is 1 (see ingest/worker.rs), so `active` only ever reaches 0 or 1 —
/// `total` is the queue depth including the job in flight.
fn update_job_count(state: &AppState, event: &Event) {
    let mut jobs = state.jobs.lock().unwrap_or_else(|e| e.into_inner());
    match event {
        Event::Discovered { .. } => jobs.1 += 1,
        Event::Progress { .. } => jobs.0 = 1,
        Event::Done { .. } | Event::Failed { .. } => {
            jobs.0 = 0;
            jobs.1 = jobs.1.saturating_sub(1);
        }
    }
}

pub fn run() {
    let paths = Paths::resolve().expect("resolve application directories");
    paths.ensure().expect("create application directories");
    let _log_guard = unottr_core::logging::init(&paths).expect("init logging");

    let app = tauri::Builder::default()
        // must be the first plugin registered (tauri-plugin-single-instance docs) — a second
        // launch fires this callback in the first instance and exits itself before .setup runs
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            ipc::commands::list_recordings,
            ipc::commands::get_recording,
            ipc::commands::search,
            ipc::commands::rename_speaker,
            ipc::commands::retry_job,
            ipc::commands::add_watch_folder,
            ipc::commands::remove_watch_folder,
            ipc::commands::list_watch_folders,
            ipc::commands::set_watch_folder_enabled,
            ipc::commands::set_watch_folder_track_rule,
            ipc::commands::start_backfill,
            ipc::commands::backfill_estimate,
            ipc::commands::get_settings,
            ipc::commands::set_setting,
            ipc::commands::list_models,
            ipc::commands::detected_device,
            ipc::commands::disk_usage,
            ipc::commands::download_model,
            ipc::commands::cancel_model_download,
            ipc::commands::clear_cache,
            ipc::commands::get_log_dir,
            ipc::commands::export_transcript,
        ])
        .setup(move |app| {
            let db = Database::open(paths.db_file())?;
            info!(db = %db.path().display(), "storage ready");

            // recordings/watch folders may already exist (prior runs, seeded db); the static
            // scope in tauri.conf.json is empty, so convertFileSrc needs this to work at all
            if let Ok(conn) = db.connect()
                && let Err(e) = scope::seed_from_db(app.handle(), &conn)
            {
                warn!(error = %e, "failed to seed asset protocol scope");
            }

            // packaging (07): AppImage carries its own ffmpeg/ffprobe as bundle resources.
            // Point the existing env-override knob at them so `FfmpegCli::discover()` (used by
            // every from_settings() call, including the settings-screen preflight) picks them
            // up for free — a settings override still wins since from_settings checks that first.
            if let Ok(res_dir) = app.path().resource_dir() {
                for (var, name) in [("UNOTTR_FFMPEG", "ffmpeg"), ("UNOTTR_FFPROBE", "ffprobe")] {
                    let bundled = res_dir.join(name);
                    if env::var_os(var).is_none() && bundled.is_file() {
                        // safe: still single-threaded, before any worker thread is spawned
                        unsafe { env::set_var(var, bundled) };
                    }
                }
            }

            let settings = {
                let conn = db.connect()?;
                unottr_core::db::settings::load(&conn)?
            };

            let backend =
                FfmpegCli::from_settings(settings.ffmpeg_path.as_deref(), settings.ffprobe_path.as_deref());
            // preflight (07-hardening-and-packaging.md): never fatal to startup — a missing
            // ffmpeg just means every job parks with a typed, retryable error; the frontend
            // polls `get_settings().ffmpeg_ok` for the persistent banner instead of an event
            if let Err(e) = backend.check() {
                warn!(error = %e, "ffmpeg/ffprobe not usable at startup; jobs will park until fixed");
            }

            // settings' cache override only relocates the pcm cache subdir (Paths::with_cache_dir)
            let run_paths = match &settings.cache_dir {
                Some(dir) => paths.with_cache_dir(PathBuf::from(dir)),
                None => paths.clone(),
            };
            run_paths.ensure()?;

            let store = ModelStore::new(run_paths.models_dir());
            let pipeline_cfg = {
                let conn = db.connect()?;
                unottr_core::db::settings::pipeline_config(&conn)?
            };

            // settings_aware=true: the worker re-reads pipeline_config from the db before
            // every job, so tier/language/device/threshold changes apply without a restart
            let (service, events_rx) = IngestService::start(
                db.clone(),
                run_paths.clone(),
                backend,
                store,
                IngestConfig::default(),
                pipeline_cfg,
                true,
            )?;

            // tray build can fail (no notification area) — that's a degraded session, not
            // a startup error; see tray.rs's doc comment for how CloseRequested then falls
            // through to tauri's normal graceful exit path instead of hiding to tray.
            let tray = tray::build(app.handle()).ok();
            let tray_available = tray.is_some();

            let app_handle = app.handle().clone();
            thread::spawn(move || forward_events(app_handle, events_rx));

            app.manage(AppState {
                paths: run_paths,
                db,
                ingest: Mutex::new(Some(service)),
                tray: Mutex::new(tray),
                tray_available,
                downloads: Mutex::new(HashMap::new()),
                jobs: Mutex::new((0, 0)),
            });

            if let Some(window) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        handle_close_requested(&app_handle, api);
                    }
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("build tauri application");

    app.run(|app_handle, event| {
        // worker finishes its current chunk and checkpoints before shutdown returns
        // (04-ingest.md) — deliberately blocks the exit path on that.
        if let tauri::RunEvent::Exit = event
            && let Some(state) = app_handle.try_state::<AppState>()
            && let Some(service) = state.ingest.lock().unwrap_or_else(|e| e.into_inner()).take()
        {
            info!("shutting down ingest service");
            service.shutdown();
        }
    });
}

/// No tray -> `state.tray` is `None` -> this never intercepts, so the close falls through to
/// tauri's default single-window-close-exits-app path, which already runs the graceful
/// `IngestService::shutdown` via the `RunEvent::Exit` handler above. Tray present -> hide
/// instead of closing, unless the user has turned close-to-tray off in settings.
fn handle_close_requested(app: &tauri::AppHandle, api: &tauri::CloseRequestApi) {
    let Some(state) = app.try_state::<AppState>() else { return };
    let Ok(guard) = state.tray.lock() else { return };
    let Some(tray) = guard.as_ref() else { return };

    let close_to_tray = state
        .db
        .connect()
        .ok()
        .and_then(|conn| unottr_core::db::settings::load(&conn).ok())
        .map(|s| s.close_to_tray)
        .unwrap_or(true);
    if !close_to_tray {
        return; // let the close proceed as a normal quit
    }

    api.prevent_close();
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }

    let already_explained = state
        .db
        .connect()
        .ok()
        .and_then(|conn| unottr_core::db::settings::close_to_tray_explained(&conn).ok())
        .unwrap_or(false);
    tray.hint_first_hide(already_explained);
    if !already_explained
        && let Ok(conn) = state.db.connect()
        && let Err(e) = unottr_core::db::settings::mark_close_to_tray_explained(&conn)
    {
        warn!(error = %e, "failed to persist close-to-tray hint flag");
    }
}
