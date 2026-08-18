use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result, RetryPolicy};

/// Seconds since the epoch. Everything in the schema stores integer unix time.
pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

/// The frozen state machine (05-ipc-contract.md). `Merging` never lands in `recordings.status`
/// — diarize's `persist()` writes `Done` directly in the same transaction as the merge — it
/// exists here only so ingest can emit a synthetic progress event for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Discovered,
    Probing,
    Extracting,
    Transcribing,
    Diarizing,
    Merging,
    Done,
    Failed,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Discovered => "discovered",
            Status::Probing => "probing",
            Status::Extracting => "extracting",
            Status::Transcribing => "transcribing",
            Status::Diarizing => "diarizing",
            Status::Merging => "merging",
            Status::Done => "done",
            Status::Failed => "failed",
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Status::Done | Status::Failed)
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "discovered" => Status::Discovered,
            "probing" => Status::Probing,
            "extracting" => Status::Extracting,
            "transcribing" => Status::Transcribing,
            "diarizing" => Status::Diarizing,
            "merging" => Status::Merging,
            "done" => Status::Done,
            "failed" => Status::Failed,
            _ => return None,
        })
    }
}

impl std::fmt::Display for Status {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Row id for a path, creating a bare one if it is not tracked yet.
///
/// The fingerprint columns are zeroed — the watcher (ingest::watch) is what creates rows with
/// real fingerprints. This exists so the standalone `unottr transcribe`/`diarize` commands can
/// run on a file nobody has scanned.
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
         VALUES (?1, 0, x'', x'', ?2, 'discovered', ?3, ?3)",
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

pub fn find_by_path(conn: &Connection, path: &Path) -> Result<Option<i64>> {
    Ok(conn
        .query_row(
            "SELECT id FROM recordings WHERE path = ?1",
            [path.to_string_lossy().as_ref()],
            |row| row.get(0),
        )
        .optional()?)
}

/// Fingerprint match, for move/rename re-linking. `size`/`head`/`tail` are the raw components
/// (see `ingest::fingerprint::Fingerprint`) — this module stays ignorant of the ingest crate.
pub fn find_by_fingerprint(
    conn: &Connection,
    size: u64,
    head: &[u8],
    tail: &[u8],
) -> Result<Option<i64>> {
    Ok(conn
        .query_row(
            "SELECT id FROM recordings WHERE fp_size = ?1 AND fp_head = ?2 AND fp_tail = ?3",
            params![size as i64, head, tail],
            |row| row.get(0),
        )
        .optional()?)
}

/// A brand-new file the watcher has never seen. Starts life `Discovered`.
pub fn insert_discovered(conn: &Connection, path: &Path, size: u64, head: &[u8], tail: &[u8]) -> Result<i64> {
    let ts = now();
    conn.execute(
        "INSERT INTO recordings (path, fp_size, fp_head, fp_tail, status, available, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'discovered', 1, ?5, ?5)",
        params![path.to_string_lossy().as_ref(), size as i64, head, tail, ts],
    )?;
    Ok(conn.last_insert_rowid())
}

/// A fingerprint match at a new path: the file moved or was renamed. Never touches status,
/// attempts, or any transcript data — the row's history stays intact.
pub fn relink(conn: &Connection, id: i64, path: &Path) -> Result<()> {
    conn.execute(
        "UPDATE recordings SET path = ?2, available = 1, updated_at = ?3 WHERE id = ?1",
        params![id, path.to_string_lossy().as_ref(), now()],
    )?;
    Ok(())
}

/// `(size, head, tail)`, as stored by `insert_discovered`.
pub type FingerprintRow = (u64, Vec<u8>, Vec<u8>);

/// The stored fingerprint components, for the missing-file sweep to search other watch
/// folders before giving up and marking a row unavailable.
pub fn fingerprint_of(conn: &Connection, id: i64) -> Result<Option<FingerprintRow>> {
    Ok(conn
        .query_row(
            "SELECT fp_size, fp_head, fp_tail FROM recordings WHERE id = ?1",
            [id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)? as u64,
                    row.get::<_, Vec<u8>>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                ))
            },
        )
        .optional()?)
}

/// A file reappeared at the exact path it was last seen at (not a move) — cheap no-op unless
/// it was actually marked unavailable.
pub fn restore_if_unavailable(conn: &Connection, id: i64) -> Result<()> {
    conn.execute(
        "UPDATE recordings SET available = 1, updated_at = ?2 WHERE id = ?1 AND available = 0",
        params![id, now()],
    )?;
    Ok(())
}

pub fn mark_unavailable(conn: &Connection, id: i64) -> Result<()> {
    conn.execute(
        "UPDATE recordings SET available = 0, updated_at = ?2 WHERE id = ?1",
        params![id, now()],
    )?;
    Ok(())
}

pub fn set_probe_result(conn: &Connection, id: i64, container: &str, duration_ms: Option<u64>) -> Result<()> {
    conn.execute(
        "UPDATE recordings SET container = ?2, duration_ms = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, container, duration_ms.map(|d| d as i64), now()],
    )?;
    Ok(())
}

pub fn set_status(conn: &Connection, id: i64, status: Status, stage_detail: Option<&str>) -> Result<()> {
    conn.execute(
        "UPDATE recordings SET status = ?2, stage_detail = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, status.as_str(), stage_detail, now()],
    )?;
    Ok(())
}

pub fn status_of(conn: &Connection, id: i64) -> Result<Option<Status>> {
    let raw: Option<String> = conn
        .query_row("SELECT status FROM recordings WHERE id = ?1", [id], |row| row.get(0))
        .optional()?;
    Ok(raw.and_then(|s| Status::parse(&s)))
}

pub fn path_of(conn: &Connection, id: i64) -> Result<Option<PathBuf>> {
    let raw: Option<String> = conn
        .query_row("SELECT path FROM recordings WHERE id = ?1", [id], |row| row.get(0))
        .optional()?;
    Ok(raw.map(PathBuf::from))
}

/// Bumps `attempts`, records the error slug, and applies `error`'s `retry_policy` (07's
/// failure taxonomy — `Terminal`/`OnFix` park after this one failure, `Bounded` parks once
/// `max_attempts` is hit). Returns `true` if it will be retried, `false` if it just parked.
/// `Cancelled` never reaches here — the worker treats a graceful shutdown as "leave it
/// exactly as it is".
pub fn fail_or_retry(conn: &Connection, id: i64, error: &Error, max_attempts: i64) -> Result<bool> {
    let slug = error.slug();
    let attempts: i64 = conn.query_row(
        "UPDATE recordings SET attempts = attempts + 1, error = ?2, updated_at = ?3
         WHERE id = ?1
         RETURNING attempts",
        params![id, slug, now()],
        |row| row.get(0),
    )?;

    let park = match error.retry_policy(max_attempts) {
        RetryPolicy::Terminal | RetryPolicy::OnFix => true,
        RetryPolicy::Bounded(n) => attempts >= n,
    };

    if park {
        conn.execute(
            "UPDATE recordings SET status = 'failed', stage_detail = NULL, updated_at = ?2 WHERE id = ?1",
            params![id, now()],
        )?;
        Ok(false)
    } else {
        Ok(true)
    }
}

/// Persists the "this recording's whisper stage ran into a GPU OOM, use CPU from now on"
/// fallback (07-hardening-and-packaging.md decision #19). Sticky across retries and restarts
/// — a card that OOMs on a file will OOM on it again, so `pipeline::process_recording` reads
/// this back every run rather than the worker re-detecting it each time.
pub fn set_force_cpu(conn: &Connection, id: i64, force_cpu: bool) -> Result<()> {
    conn.execute(
        "UPDATE recordings SET force_cpu = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, force_cpu, now()],
    )?;
    Ok(())
}

pub fn force_cpu_of(conn: &Connection, id: i64) -> Result<bool> {
    Ok(conn
        .query_row("SELECT force_cpu FROM recordings WHERE id = ?1", [id], |row| {
            row.get::<_, i64>(0)
        })
        .optional()?
        .unwrap_or(0)
        != 0)
}

/// Retry from the UI: only acts on a currently-`failed` row, clearing error/attempts and
/// putting it back in the non-terminal set so the caller can `enqueue` it. `last_chunk_idx`
/// is left alone — transcribe resumes from there instead of redoing finished chunks. Returns
/// `false` (no-op) if the row wasn't `failed`, e.g. a stale/duplicate click.
pub fn reset_for_retry(conn: &Connection, id: i64) -> Result<bool> {
    let changed = conn.execute(
        "UPDATE recordings SET status = 'discovered', error = NULL, attempts = 0,
                stage_detail = NULL, updated_at = ?2
         WHERE id = ?1 AND status = 'failed'",
        params![id, now()],
    )?;
    Ok(changed > 0)
}

/// Ids in any non-terminal state — what startup reconciliation requeues.
pub fn non_terminal(conn: &Connection) -> Result<Vec<i64>> {
    let mut stmt = conn.prepare("SELECT id FROM recordings WHERE status NOT IN ('done', 'failed')")?;
    let rows = stmt.query_map([], |row| row.get(0))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Every path currently marked available, for the startup "did it disappear" sweep.
pub fn available_paths(conn: &Connection) -> Result<Vec<(i64, PathBuf)>> {
    let mut stmt = conn.prepare("SELECT id, path FROM recordings WHERE available = 1")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, i64>(0)?, PathBuf::from(row.get::<_, String>(1)?)))
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
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
    fn stubbing_the_same_path_twice_reuses_the_row() {
        let (_d, db) = temp_db();
        let conn = db.connect().unwrap();
        let id = stub(&conn, Path::new("/tmp/a.mkv"), None).unwrap();
        assert_eq!(stub(&conn, Path::new("/tmp/a.mkv"), None).unwrap(), id);
        assert_eq!(status_of(&conn, id).unwrap(), Some(Status::Discovered));
    }

    #[test]
    fn a_new_fingerprint_finds_nothing() {
        let (_d, db) = temp_db();
        let conn = db.connect().unwrap();
        assert_eq!(find_by_fingerprint(&conn, 10, b"a", b"b").unwrap(), None);
    }

    #[test]
    fn relinking_preserves_everything_but_the_path() {
        let (_d, db) = temp_db();
        let conn = db.connect().unwrap();
        let id = insert_discovered(&conn, Path::new("/old/a.mkv"), 10, b"aaaa", b"bbbb").unwrap();
        conn.execute("UPDATE recordings SET attempts = 3 WHERE id = ?1", [id])
            .unwrap();

        relink(&conn, id, Path::new("/new/a.mkv")).unwrap();

        assert_eq!(path_of(&conn, id).unwrap(), Some(PathBuf::from("/new/a.mkv")));
        let attempts: i64 = conn
            .query_row("SELECT attempts FROM recordings WHERE id = ?1", [id], |r| r.get(0))
            .unwrap();
        assert_eq!(attempts, 3, "relink must not touch retry state");
    }

    /// A `Bounded`-policy error (io/whisper/diarize all behave the same way here).
    fn bounded_err() -> Error {
        Error::Whisper("decode failed".into())
    }

    #[test]
    fn a_bounded_error_retries_twice_then_parks() {
        let (_d, db) = temp_db();
        let conn = db.connect().unwrap();
        let id = stub(&conn, Path::new("/tmp/a.mkv"), None).unwrap();

        assert!(fail_or_retry(&conn, id, &bounded_err(), 3).unwrap());
        assert_eq!(status_of(&conn, id).unwrap(), Some(Status::Discovered));
        assert!(fail_or_retry(&conn, id, &bounded_err(), 3).unwrap());
        assert!(!fail_or_retry(&conn, id, &bounded_err(), 3).unwrap());
        assert_eq!(status_of(&conn, id).unwrap(), Some(Status::Failed));
    }

    #[test]
    fn a_terminal_error_parks_after_one_failure_regardless_of_max_attempts() {
        let (_d, db) = temp_db();
        let conn = db.connect().unwrap();
        let id = stub(&conn, Path::new("/tmp/a.mkv"), None).unwrap();
        let err = Error::Truncated { path: PathBuf::from("/tmp/a.mkv") };

        assert!(!fail_or_retry(&conn, id, &err, 10).unwrap(), "terminal errors never retry");
        assert_eq!(status_of(&conn, id).unwrap(), Some(Status::Failed));
        let error: Option<String> = conn
            .query_row("SELECT error FROM recordings WHERE id = ?1", [id], |r| r.get(0))
            .unwrap();
        assert_eq!(error.as_deref(), Some("truncated"));
    }

    #[test]
    fn an_on_fix_error_parks_after_one_failure_but_is_meant_to_be_retried_manually() {
        let (_d, db) = temp_db();
        let conn = db.connect().unwrap();
        let id = stub(&conn, Path::new("/tmp/a.mkv"), None).unwrap();

        assert!(!fail_or_retry(&conn, id, &Error::FfmpegMissing, 10).unwrap());
        assert_eq!(status_of(&conn, id).unwrap(), Some(Status::Failed));
        // the point of OnFix vs Terminal is purely UI-facing (install hint + Retry button);
        // the mechanics of unparking are the same reset_for_retry every failed row gets
        assert!(reset_for_retry(&conn, id).unwrap());
    }

    #[test]
    fn force_cpu_round_trips_and_defaults_false() {
        let (_d, db) = temp_db();
        let conn = db.connect().unwrap();
        let id = stub(&conn, Path::new("/tmp/a.mkv"), None).unwrap();
        assert!(!force_cpu_of(&conn, id).unwrap());

        set_force_cpu(&conn, id, true).unwrap();
        assert!(force_cpu_of(&conn, id).unwrap());
    }

    #[test]
    fn reset_for_retry_requeues_a_failed_row_and_ignores_others() {
        let (_d, db) = temp_db();
        let conn = db.connect().unwrap();
        let id = stub(&conn, Path::new("/tmp/a.mkv"), None).unwrap();
        assert!(!fail_or_retry(&conn, id, &bounded_err(), 1).unwrap(), "1 attempt parks immediately");
        assert_eq!(status_of(&conn, id).unwrap(), Some(Status::Failed));

        assert!(reset_for_retry(&conn, id).unwrap());
        assert_eq!(status_of(&conn, id).unwrap(), Some(Status::Discovered));
        let (attempts, error): (i64, Option<String>) = conn
            .query_row("SELECT attempts, error FROM recordings WHERE id = ?1", [id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(attempts, 0);
        assert_eq!(error, None);

        // already non-terminal: no-op
        assert!(!reset_for_retry(&conn, id).unwrap());
    }

    #[test]
    fn non_terminal_skips_done_and_failed() {
        let (_d, db) = temp_db();
        let conn = db.connect().unwrap();
        let a = stub(&conn, Path::new("/tmp/a.mkv"), None).unwrap();
        let b = stub(&conn, Path::new("/tmp/b.mkv"), None).unwrap();
        set_status(&conn, a, Status::Done, None).unwrap();

        let ids = non_terminal(&conn).unwrap();
        assert_eq!(ids, vec![b]);
    }
}
