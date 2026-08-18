mod migrations;
pub mod recordings;

use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::error::{IoResultExt, Result};

pub use migrations::{MIGRATIONS, current_version};

/// Owns the database location and hands out tuned connections. WAL lets the UI read while
/// the pipeline worker writes, so readers get their own connection rather than sharing one.
#[derive(Debug, Clone)]
pub struct Database {
    path: PathBuf,
}

impl Database {
    pub fn open(path: impl Into<PathBuf>) -> Result<Self> {
        let path = path.into();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).at(parent)?;
        }

        let db = Self { path };
        let mut conn = db.connect()?;
        migrations::apply(&mut conn)?;
        Ok(db)
    }

    pub fn connect(&self) -> Result<Connection> {
        let conn = Connection::open(&self.path)?;
        tune(&conn)?;
        Ok(conn)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

fn tune(conn: &Connection) -> Result<()> {
    // journal_mode returns a row, so it cannot go through pragma_update
    let mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
    debug_assert_eq!(mode.to_lowercase(), "wal");

    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "busy_timeout", 5000)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> (tempfile::TempDir, Database) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path().join("test.db")).unwrap();
        (dir, db)
    }

    #[test]
    fn migrates_from_scratch() {
        let (_dir, db) = temp_db();
        let conn = db.connect().unwrap();
        assert_eq!(current_version(&conn).unwrap(), MIGRATIONS.len() as u32);
    }

    #[test]
    fn migrating_twice_is_a_noop() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.db");
        Database::open(&path).unwrap();
        let db = Database::open(&path).unwrap();

        let conn = db.connect().unwrap();
        assert_eq!(current_version(&conn).unwrap(), MIGRATIONS.len() as u32);
        let tables: u32 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'recordings'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tables, 1);
    }

    #[test]
    fn schema_has_every_table() {
        let (_dir, db) = temp_db();
        let conn = db.connect().unwrap();
        for table in [
            "recordings",
            "speakers",
            "segments",
            "segments_fts",
            "watch_folders",
            "settings",
        ] {
            let found: u32 = conn
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE name = ?1",
                    [table],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(found, 1, "missing {table}");
        }
    }

    #[test]
    fn fts_tracks_segment_writes() {
        let (_dir, db) = temp_db();
        let conn = db.connect().unwrap();
        conn.execute_batch(
            "INSERT INTO recordings (id, path, fp_size, fp_head, fp_tail, status, created_at, updated_at)
             VALUES (1, '/tmp/a.mkv', 1, x'00', x'00', 'done', 0, 0);
             INSERT INTO segments (id, recording_id, chunk_idx, start_ms, end_ms, text)
             VALUES (1, 1, 0, 0, 1000, 'quarterly roadmap review');",
        )
        .unwrap();

        let hits: u32 = conn
            .query_row(
                "SELECT count(*) FROM segments_fts WHERE segments_fts MATCH 'roadmap'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1);

        conn.execute("DELETE FROM segments WHERE id = 1", [])
            .unwrap();
        let hits: u32 = conn
            .query_row(
                "SELECT count(*) FROM segments_fts WHERE segments_fts MATCH 'roadmap'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(hits, 0);
    }

    #[test]
    fn deleting_a_recording_cascades() {
        let (_dir, db) = temp_db();
        let conn = db.connect().unwrap();
        conn.execute_batch(
            "INSERT INTO recordings (id, path, fp_size, fp_head, fp_tail, status, created_at, updated_at)
             VALUES (1, '/tmp/a.mkv', 1, x'00', x'00', 'done', 0, 0);
             INSERT INTO speakers (id, recording_id, label) VALUES (1, 1, 'Speaker 1');
             INSERT INTO segments (id, recording_id, chunk_idx, start_ms, end_ms, text, speaker_id)
             VALUES (1, 1, 0, 0, 1000, 'hello', 1);",
        )
        .unwrap();

        conn.execute("DELETE FROM recordings WHERE id = 1", [])
            .unwrap();
        let segments: u32 = conn
            .query_row("SELECT count(*) FROM segments", [], |row| row.get(0))
            .unwrap();
        assert_eq!(segments, 0);
    }
}
