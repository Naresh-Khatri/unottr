//! Dynamic asset protocol scope. `tauri.conf.json` ships an empty static scope (folders
//! aren't known at build time), so `convertFileSrc` only works for paths allowed here —
//! at startup for what's already in the db, and at runtime as folders get added.

use rusqlite::Connection;
use tauri::{AppHandle, Manager};
use tracing::warn;

/// Allow every enabled watch folder, plus the containing dir of every recording (recordings
/// can predate scope logic entirely, e.g. rows from the phase-02 CLI harness).
pub fn seed_from_db(app: &AppHandle, conn: &Connection) -> rusqlite::Result<()> {
    let asset_scope = app.asset_protocol_scope();

    let mut folders = conn.prepare("SELECT path FROM watch_folders WHERE enabled = 1")?;
    for path in folders.query_map([], |r| r.get::<_, String>(0))? {
        let path = path?;
        if let Err(e) = asset_scope.allow_directory(&path, true) {
            warn!(error = %e, path, "failed to allow watch folder in asset scope");
        }
    }

    let mut recordings = conn.prepare("SELECT DISTINCT path FROM recordings")?;
    for path in recordings.query_map([], |r| r.get::<_, String>(0))? {
        let path = path?;
        if let Some(parent) = std::path::Path::new(&path).parent()
            && let Err(e) = asset_scope.allow_directory(parent, false)
        {
            warn!(error = %e, path, "failed to allow recording's directory in asset scope");
        }
    }

    Ok(())
}

/// Called when a folder is added after launch so `convertFileSrc` works on it immediately,
/// without waiting for a restart.
pub fn allow_watch_folder(app: &AppHandle, path: &str) -> tauri::Result<()> {
    app.asset_protocol_scope().allow_directory(path, true)
}
