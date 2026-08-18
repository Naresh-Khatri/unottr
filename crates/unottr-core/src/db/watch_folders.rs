use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::media::TrackRule;

/// Mirrors the `WatchFolder` shape frozen in 05-ipc-contract.md exactly, so a Tauri command
/// can return this struct straight over IPC.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WatchFolder {
    pub id: i64,
    pub path: PathBuf,
    /// `"auto"` or a JSON-serialized `TrackRule`. Kept as the raw string on the wire — the
    /// IPC type table says `"auto" | string`, not a parsed rule.
    pub track_rule: String,
    pub enabled: bool,
}

impl WatchFolder {
    /// Parses `track_rule`; falls back to `Auto` on garbage rather than failing the scan.
    pub fn rule(&self) -> TrackRule {
        if self.track_rule == "auto" {
            return TrackRule::Auto;
        }
        serde_json::from_str(&self.track_rule).unwrap_or(TrackRule::Auto)
    }
}

fn from_row(row: &rusqlite::Row) -> rusqlite::Result<WatchFolder> {
    Ok(WatchFolder {
        id: row.get(0)?,
        path: PathBuf::from(row.get::<_, String>(1)?),
        track_rule: row.get(2)?,
        enabled: row.get::<_, i64>(3)? != 0,
    })
}

const SELECT: &str = "SELECT id, path, track_rule, enabled FROM watch_folders";

pub fn list(conn: &Connection) -> Result<Vec<WatchFolder>> {
    let mut stmt = conn.prepare(&format!("{SELECT} ORDER BY id"))?;
    let rows = stmt.query_map([], from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn list_enabled(conn: &Connection) -> Result<Vec<WatchFolder>> {
    let mut stmt = conn.prepare(&format!("{SELECT} WHERE enabled = 1 ORDER BY id"))?;
    let rows = stmt.query_map([], from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn get(conn: &Connection, id: i64) -> Result<Option<WatchFolder>> {
    Ok(conn
        .query_row(&format!("{SELECT} WHERE id = ?1"), [id], from_row)
        .optional()?)
}

pub fn find_by_path(conn: &Connection, path: &Path) -> Result<Option<WatchFolder>> {
    Ok(conn
        .query_row(
            &format!("{SELECT} WHERE path = ?1"),
            [path.to_string_lossy().as_ref()],
            from_row,
        )
        .optional()?)
}

/// Adds a folder, or returns the existing row if it is already watched — idempotent so
/// backfill can register-and-scan in one call without erroring on a repeat.
pub fn add(conn: &Connection, path: &Path) -> Result<WatchFolder> {
    if let Some(existing) = find_by_path(conn, path)? {
        return Ok(existing);
    }
    conn.execute(
        "INSERT INTO watch_folders (path) VALUES (?1)",
        [path.to_string_lossy().as_ref()],
    )?;
    let id = conn.last_insert_rowid();
    Ok(get(conn, id)?.expect("just inserted"))
}

pub fn remove(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM watch_folders WHERE id = ?1", [id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Database;

    fn temp_db() -> (tempfile::TempDir, Database) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path().join("t.db")).unwrap();
        (dir, db)
    }

    #[test]
    fn adding_twice_is_idempotent() {
        let (_d, db) = temp_db();
        let conn = db.connect().unwrap();
        let a = add(&conn, Path::new("/rec")).unwrap();
        let b = add(&conn, Path::new("/rec")).unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(list(&conn).unwrap().len(), 1);
    }

    #[test]
    fn defaults_to_auto_and_enabled() {
        let (_d, db) = temp_db();
        let conn = db.connect().unwrap();
        let wf = add(&conn, Path::new("/rec")).unwrap();
        assert_eq!(wf.track_rule, "auto");
        assert!(wf.enabled);
        assert_eq!(wf.rule(), TrackRule::Auto);
    }

    #[test]
    fn removing_drops_the_row() {
        let (_d, db) = temp_db();
        let conn = db.connect().unwrap();
        let wf = add(&conn, Path::new("/rec")).unwrap();
        remove(&conn, wf.id).unwrap();
        assert!(get(&conn, wf.id).unwrap().is_none());
    }
}
