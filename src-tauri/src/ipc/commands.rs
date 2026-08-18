//! `#[tauri::command]` wrappers. Thin — all logic lives in `queries` so it's testable
//! without a running app; these just open a connection, call through, and stringify errors.

use tauri::{AppHandle, State};

use super::queries;
use super::types::{RecordingDetail, RecordingFilter, RecordingSort, RecordingSummary, SearchHit, WatchFolder};
use crate::{AppState, scope};

type CmdResult<T> = Result<T, String>;

fn connect(state: &State<AppState>) -> CmdResult<rusqlite::Connection> {
    state.db.connect().map_err(|e| e.to_string())
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
    let conn = connect(&state)?;
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
