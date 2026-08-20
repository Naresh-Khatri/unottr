//! `#[tauri::command]` wrappers. Thin — all logic lives in `queries` so it's testable
//! without a running app; these just open a connection, call through, and stringify errors.

use std::thread;

use tauri::{AppHandle, State};
use tracing::warn;
use unottr_core::CancelToken;

use super::events;
use super::queries;
use super::types::{
    BackfillEstimate, DiskUsage, ModelInfo, RecordingDetail, RecordingFilter, RecordingSort,
    RecordingSummary, Resolved, SearchHit, Settings, WatchFolder,
};
use crate::{AppState, scope};

type CmdResult<T> = Result<T, String>;

fn connect(state: &State<AppState>) -> CmdResult<rusqlite::Connection> {
    state.db.connect().map_err(|e| e.to_string())
}

/// Core stores settings as free-form kv (see `db::settings::keys`); it never validates a
/// value, so a bad one would silently persist and only surface confusingly on the next job.
/// This is the ipc boundary's job instead.
fn validate_setting(key: &str, value: &str) -> CmdResult<()> {
    use unottr_core::db::settings::keys;
    let ok = match key {
        keys::MODEL_TIER => ["auto", "turbo", "medium", "small"].contains(&value),
        keys::DEVICE => ["auto", "gpu", "cpu"].contains(&value),
        keys::LANGUAGE => !value.is_empty(),
        keys::DIARIZE_THRESHOLD => value.parse::<f32>().is_ok_and(|n| (0.0..=1.0).contains(&n)),
        keys::FFMPEG_PATH | keys::FFPROBE_PATH | keys::CACHE_DIR => true, // "" clears the override
        keys::AUTOSTART | keys::CLOSE_TO_TRAY => value == "0" || value == "1",
        // ui-only flag, not one of core's Settings fields — see types::Settings doc comment
        "first_run_complete" => value == "0" || value == "1",
        _ => return Err(format!("unknown setting key {key}")),
    };
    if ok { Ok(()) } else { Err(format!("invalid value {value:?} for setting {key}")) }
}

#[tauri::command(rename_all = "snake_case")]
pub fn list_recordings(
    state: State<AppState>,
    filter: Option<RecordingFilter>,
    sort: Option<RecordingSort>,
) -> CmdResult<Vec<RecordingSummary>> {
    let conn = connect(&state)?;
    queries::list_recordings(&conn, &filter.unwrap_or_default(), &sort.unwrap_or_default())
        .map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_recording(state: State<AppState>, id: i64) -> CmdResult<RecordingDetail> {
    let conn = connect(&state)?;
    queries::get_recording(&conn, id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("recording {id} not found"))
}

#[tauri::command(rename_all = "snake_case")]
pub fn search(state: State<AppState>, query: String, limit: i64) -> CmdResult<Vec<SearchHit>> {
    let conn = connect(&state)?;
    queries::search(&conn, &query, limit).map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "snake_case")]
pub fn rename_speaker(state: State<AppState>, speaker_id: i64, name: String) -> CmdResult<()> {
    let conn = connect(&state)?;
    queries::rename_speaker(&conn, speaker_id, &name).map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "snake_case")]
pub fn retry_job(state: State<AppState>, recording_id: i64) -> CmdResult<()> {
    let was_failed = {
        let conn = connect(&state)?;
        queries::retry_job(&conn, recording_id).map_err(|e| e.to_string())?
    };
    if was_failed && let Ok(guard) = state.ingest.lock() && let Some(service) = guard.as_ref() {
        service.enqueue(recording_id);
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn add_watch_folder(app: AppHandle, state: State<AppState>, path: String) -> CmdResult<WatchFolder> {
    // preflight (07-hardening-and-packaging.md): refuse rather than register a folder whose
    // every discovered file is certain to park on FfmpegMissing
    let conn = connect(&state)?;
    let s = unottr_core::db::settings::load(&conn).map_err(|e| e.to_string())?;
    unottr_core::media::FfmpegCli::from_settings(s.ffmpeg_path.as_deref(), s.ffprobe_path.as_deref())
        .check()
        .map_err(|_| "ffmpeg/ffprobe not found — fix that in Settings before adding a folder".to_string())?;
    let folder = queries::add_watch_folder(&conn, &path).map_err(|e| e.to_string())?;
    if let Err(e) = scope::allow_watch_folder(&app, &folder.path) {
        tracing::warn!(error = %e, path = %folder.path, "failed to extend asset protocol scope");
    }
    Ok(folder)
}

#[tauri::command(rename_all = "snake_case")]
pub fn remove_watch_folder(state: State<AppState>, id: i64) -> CmdResult<()> {
    let conn = connect(&state)?;
    queries::remove_watch_folder(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "snake_case")]
pub fn list_watch_folders(state: State<AppState>) -> CmdResult<Vec<WatchFolder>> {
    let conn = connect(&state)?;
    queries::list_watch_folders(&conn).map_err(|e| e.to_string())
}

/// Scans and confirms in one shot — the explicit-confirmation requirement (04-ingest.md) is
/// satisfied by the user clicking the button that invokes this command in the first place.
#[tauri::command(rename_all = "snake_case")]
pub fn start_backfill(state: State<AppState>, folder_id: i64) -> CmdResult<()> {
    let folder = {
        let conn = connect(&state)?;
        unottr_core::db::watch_folders::get(&conn, folder_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("watch folder {folder_id} not found"))?
    };
    let ids = unottr_core::ingest::backfill::confirm(&state.db, &folder.path, &unottr_core::IngestConfig::default())
        .map_err(|e| e.to_string())?;
    if let Ok(guard) = state.ingest.lock() && let Some(service) = guard.as_ref() {
        for id in ids {
            service.enqueue(id);
        }
    }
    Ok(())
}

/// Read-only counterpart to `start_backfill` — surfaces count/duration before the user
/// commits, so the "explicit confirm" step in the first-run flow has something to confirm.
#[tauri::command(rename_all = "snake_case")]
pub fn backfill_estimate(state: State<AppState>, folder_id: i64) -> CmdResult<BackfillEstimate> {
    let folder = {
        let conn = connect(&state)?;
        unottr_core::db::watch_folders::get(&conn, folder_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("watch folder {folder_id} not found"))?
    };
    let backend = unottr_core::media::FfmpegCli::discover();
    unottr_core::ingest::backfill::scan(&folder.path, &unottr_core::IngestConfig::default(), &backend)
        .map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "snake_case")]
pub fn set_watch_folder_enabled(state: State<AppState>, id: i64, enabled: bool) -> CmdResult<()> {
    let conn = connect(&state)?;
    unottr_core::db::watch_folders::set_enabled(&conn, id, enabled).map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "snake_case")]
pub fn set_watch_folder_track_rule(state: State<AppState>, id: i64, track_rule: String) -> CmdResult<()> {
    let conn = connect(&state)?;
    unottr_core::db::watch_folders::set_track_rule(&conn, id, &track_rule).map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_settings(state: State<AppState>) -> CmdResult<Settings> {
    let conn = connect(&state)?;
    queries::get_settings(&conn, state.tray_available).map_err(|e| e.to_string())
}

/// One key/value pair per call — matches how the settings screen commits each control
/// independently rather than a bulk save. Pipeline-relevant keys (tier/language/device/
/// diarize threshold) take effect on the *next* job: the worker re-reads `pipeline_config`
/// before every run when `settings_aware` (see `ingest::worker::run_with_retries`). ffmpeg
/// path and cache dir are only read at startup, so those two need an app restart to apply —
/// flagged in MANUAL-CHECKS.md, not silently reloaded mid-session.
#[tauri::command(rename_all = "snake_case")]
pub fn set_setting(state: State<AppState>, key: String, value: String) -> CmdResult<Settings> {
    validate_setting(&key, &value)?;
    let conn = connect(&state)?;
    queries::set_setting(&conn, &key, &value, state.tray_available).map_err(|e| e.to_string())
}

/// What `device: "auto"` would actually resolve to right now — the compute settings group
/// shows this next to the override picker. Always probes fresh; gpu vram is not cached.
#[tauri::command(rename_all = "snake_case")]
pub fn detected_device() -> Resolved {
    unottr_core::transcribe::resolve(unottr_core::transcribe::Device::Auto)
}

#[tauri::command(rename_all = "snake_case")]
pub fn list_models(state: State<AppState>) -> CmdResult<Vec<ModelInfo>> {
    let store = unottr_core::ModelStore::new(state.paths.models_dir());
    Ok(queries::list_models(&store))
}

#[tauri::command(rename_all = "snake_case")]
pub fn disk_usage(state: State<AppState>) -> CmdResult<DiskUsage> {
    Ok(queries::disk_usage(&state.paths))
}

/// Kicks off a background download and returns immediately; progress comes back over
/// `model_download_progress` events keyed by tier. Only one download per tier at a time —
/// a second call for the same tier replaces the cancel token, effectively abandoning
/// (not stopping) the first thread, which is harmless since `ModelStore::ensure` writes to
/// a `.part` file the next attempt just resumes.
#[tauri::command(rename_all = "snake_case")]
pub fn download_model(app: AppHandle, state: State<AppState>, tier: String) -> CmdResult<()> {
    let name = unottr_core::db::settings::tier_to_model_name(&tier)
        .ok_or_else(|| format!("unknown model tier {tier}"))?;
    let spec = *unottr_core::transcribe::model::find(name)
        .ok_or_else(|| format!("model {name} not registered"))?;
    let store = unottr_core::ModelStore::new(state.paths.models_dir());
    let token = CancelToken::new();
    state
        .downloads
        .lock()
        .map_err(|e| e.to_string())?
        .insert(tier.clone(), token.clone());

    thread::spawn(move || {
        let progress = |pct: f32| {
            let _ = events::model_download_progress(&app, events::ModelDownloadProgress { model: tier.clone(), pct });
        };
        if let Err(e) = store.ensure(&spec, &progress, &token) {
            warn!(error = %e, tier, "model download did not complete");
        }
    });
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn cancel_model_download(state: State<AppState>, tier: String) -> CmdResult<()> {
    if let Ok(guard) = state.downloads.lock()
        && let Some(token) = guard.get(&tier)
    {
        token.cancel();
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn clear_cache(state: State<AppState>) -> CmdResult<()> {
    let dir = state.paths.pcm_cache_dir();
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_log_dir(state: State<AppState>) -> CmdResult<String> {
    Ok(state.paths.logs_dir().to_string_lossy().into_owned())
}

/// Escape hatch for containers webkit's gstreamer can't decode (see `lib::gst`). Takes an
/// id, not a path — the path is read back from the row here so the frontend can never hand
/// an arbitrary path to the system opener. Deliberately not the `opener` plugin's own
/// `open_path` command: its scope is static in capabilities and recording paths aren't
/// known at build time, the same reason the asset protocol needs `scope.rs`.
#[tauri::command(rename_all = "snake_case")]
pub fn open_in_default_player(state: State<AppState>, recording_id: i64) -> CmdResult<()> {
    let conn = connect(&state)?;
    let path = queries::recording_path(&conn, recording_id).map_err(|e| e.to_string())?;
    if !std::path::Path::new(&path).is_file() {
        return Err(format!("{path} is not there any more"));
    }
    tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| e.to_string())
}

/// Renders and writes in one call — `dest_path` comes from a native save dialog on the
/// frontend, never picked automatically, so there's no surprise sidecar file (06-settings-
/// and-shell.md). Serialization itself lives in `unottr_core::export` and is unit-tested
/// there; this is just the ipc plumbing around it.
#[tauri::command(rename_all = "snake_case")]
pub fn export_transcript(state: State<AppState>, recording_id: i64, format: String, dest_path: String) -> CmdResult<()> {
    let fmt = unottr_core::export::Format::parse(&format).ok_or_else(|| format!("unknown export format {format}"))?;
    let conn = connect(&state)?;
    let transcript = unottr_core::export::load(&conn, recording_id).map_err(|e| e.to_string())?;
    let rendered = unottr_core::export::render(fmt, &transcript);
    std::fs::write(&dest_path, rendered).map_err(|e| e.to_string())
}
