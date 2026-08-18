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

/// Stub until phase 04's worker exists: acknowledges the request and logs it, never fakes
/// progress or flips status itself.
#[tauri::command(rename_all = "snake_case")]
pub fn retry_job(recording_id: i64) -> CmdResult<()> {
    tracing::info!(recording_id, "retry_job requested (stub, no worker wired yet)");
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

/// Stub until phase 04's worker exists: acknowledges and logs, never fakes a scan.
#[tauri::command(rename_all = "snake_case")]
pub fn start_backfill(folder_id: i64) -> CmdResult<()> {
    tracing::info!(folder_id, "start_backfill requested (stub, no worker wired yet)");
    Ok(())
}
