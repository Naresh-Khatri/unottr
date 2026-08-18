pub mod ipc;
mod scope;

use std::sync::Mutex;
use std::thread;

use tauri::Manager;
use tracing::{info, warn};
use unottr_core::media::FfmpegCli;
use unottr_core::{Database, Event, IngestConfig, IngestService, ModelStore, Paths, PipelineConfig};

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
}

fn forward_events(app: tauri::AppHandle, events_rx: std::sync::mpsc::Receiver<Event>) {
    for event in events_rx {
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

pub fn run() {
    let paths = Paths::resolve().expect("resolve application directories");
    paths.ensure().expect("create application directories");
    let _log_guard = unottr_core::logging::init(&paths).expect("init logging");

    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            ipc::commands::list_recordings,
            ipc::commands::get_recording,
            ipc::commands::search,
            ipc::commands::rename_speaker,
            ipc::commands::retry_job,
            ipc::commands::add_watch_folder,
            ipc::commands::remove_watch_folder,
            ipc::commands::list_watch_folders,
            ipc::commands::start_backfill,
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

            // mirrors unottr-cli's `ingest run` defaults: auto device, no model overrides,
            // models must already be present (no silent background downloads from the UI)
            let backend = FfmpegCli::discover();
            let store = ModelStore::new(paths.models_dir());
            let (service, events_rx) =
                IngestService::start(db.clone(), paths.clone(), backend, store, IngestConfig::default(), PipelineConfig::default())?;

            let app_handle = app.handle().clone();
            thread::spawn(move || forward_events(app_handle, events_rx));

            app.manage(AppState { paths: paths.clone(), db, ingest: Mutex::new(Some(service)) });
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
