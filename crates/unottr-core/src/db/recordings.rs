use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};

use crate::error::Result;

/// Seconds since the epoch. Everything in the schema stores integer unix time.
pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

/// Row id for a path, creating a bare one if it is not tracked yet.
///
/// The fingerprint columns are zeroed — phase 04 owns real fingerprinting and the watcher
/// that creates these rows properly. This exists so the phase 02 cli can transcribe a file
/// nobody has scanned.
pub fn stub(conn: &Connection, path: &Path, duration_ms: Option<u64>) -> Result<i64> {
    let path = path.to_string_lossy();

    if let Some(id) = conn
        .query_row(
            "SELECT id FROM recordings WHERE path = ?1",
            [path.as_ref()],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
    {
        return Ok(id);
    }

    let ts = now();
    conn.execute(
        "INSERT INTO recordings (path, fp_size, fp_head, fp_tail, duration_ms, status, created_at, updated_at)
         VALUES (?1, 0, x'', x'', ?2, 'pending', ?3, ?3)",
        params![path.as_ref(), duration_ms.map(|d| d as i64), ts],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn last_chunk_idx(conn: &Connection, id: i64) -> Result<Option<i64>> {
    Ok(conn.query_row(
        "SELECT last_chunk_idx FROM recordings WHERE id = ?1",
        [id],
        |row| row.get(0),
    )?)
}
