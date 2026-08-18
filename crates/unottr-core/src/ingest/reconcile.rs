//! Startup reconciliation. `process_recording` always runs the full probe -> extract ->
//! transcribe -> diarize sequence regardless of which stage a row was left at (probing is
//! cheap, extraction is cache-by-existence, `transcribe::run` auto-resumes via
//! `last_chunk_idx`, diarize is safe to rerun) — so "resume" here just means "requeue every
//! non-terminal row" rather than dispatching per-stage.

use std::collections::HashSet;
use std::fs;

use crate::db::recordings;
use crate::db::Database;
use crate::error::Result;
use crate::paths::Paths;

/// Non-terminal rows to hand back to the worker.
pub fn run(db: &Database) -> Result<Vec<i64>> {
    let conn = db.connect()?;
    recordings::non_terminal(&conn)
}

/// Pcm cache entries belong to whichever recording's `file_stem` they're named after
/// (`transcribe::pcm_path_for`). Anything not backing a currently non-terminal recording is
/// either finished (extraction stage is behind it) or orphaned — either way, safe to drop.
pub fn clear_stale_pcm_cache(db: &Database, paths: &Paths) -> Result<()> {
    let conn = db.connect()?;
    let mut keep: HashSet<String> = HashSet::new();
    for id in recordings::non_terminal(&conn)? {
        if let Some(path) = recordings::path_of(&conn, id)?
            && let Some(stem) = path.file_stem()
        {
            keep.insert(stem.to_string_lossy().into_owned());
        }
    }
    drop(conn);

    let cache = paths.pcm_cache_dir();
    let Ok(entries) = fs::read_dir(&cache) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        match stem_of_cache_file(name) {
            Some(stem) if !keep.contains(stem) => {
                let _ = fs::remove_file(&path);
            }
            _ => {}
        }
    }
    Ok(())
}

/// `{stem}.t{n}.pcm` or `{stem}.mix.pcm` -> `stem`, searching from the right so a stem that
/// itself contains dots (real filenames do) doesn't get truncated early.
fn stem_of_cache_file(name: &str) -> Option<&str> {
    let base = name.strip_suffix(".pcm")?;
    if let Some(stem) = base.strip_suffix(".mix") {
        return Some(stem);
    }
    let rpos = base.rfind(".t")?;
    let (stem, rest) = base.split_at(rpos);
    let digits = &rest[2..];
    (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())).then_some(stem)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;
    use crate::db::recordings::{self, Status};
    use crate::paths::Paths;

    fn temp_db() -> (tempfile::TempDir, Database) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path().join("t.db")).unwrap();
        (dir, db)
    }

    #[test]
    fn track_cache_names_recover_their_stem() {
        assert_eq!(stem_of_cache_file("meeting.t0.pcm"), Some("meeting"));
        assert_eq!(stem_of_cache_file("meeting.t12.pcm"), Some("meeting"));
        assert_eq!(stem_of_cache_file("meeting.mix.pcm"), Some("meeting"));
        assert_eq!(stem_of_cache_file("2025-10-08 11.56.33.t0.pcm"), Some("2025-10-08 11.56.33"));
        assert_eq!(stem_of_cache_file("not-a-pcm-file.txt"), None);
    }

    #[test]
    fn a_transcribing_row_is_requeued_without_touching_its_checkpoint() {
        let (_d, db) = temp_db();
        let conn = db.connect().unwrap();
        let id = recordings::stub(&conn, Path::new("/tmp/a.mkv"), None).unwrap();
        recordings::set_status(&conn, id, Status::Transcribing, Some("chunk 12/44")).unwrap();
        conn.execute("UPDATE recordings SET last_chunk_idx = 12 WHERE id = ?1", [id]).unwrap();
        // an unrelated finished row must not come back
        let done = recordings::stub(&conn, Path::new("/tmp/b.mkv"), None).unwrap();
        recordings::set_status(&conn, done, Status::Done, None).unwrap();
        drop(conn);

        let ids = run(&db).unwrap();

        assert_eq!(ids, vec![id]);
        let conn = db.connect().unwrap();
        assert_eq!(recordings::last_chunk_idx(&conn, id).unwrap(), Some(12), "resume point must survive reconciliation");
        assert_eq!(recordings::status_of(&conn, id).unwrap(), Some(Status::Transcribing));
    }

    #[test]
    fn clearing_the_pcm_cache_keeps_only_non_terminal_stems() {
        let (_tmp, db) = temp_db();
        let conn = db.connect().unwrap();
        let active = recordings::stub(&conn, Path::new("/watch/active.mp4"), None).unwrap();
        recordings::set_status(&conn, active, Status::Transcribing, None).unwrap();
        drop(conn);

        let root = tempfile::tempdir().unwrap();
        let paths = Paths::for_test(root.path());
        paths.ensure().unwrap();
        let cache = paths.pcm_cache_dir();
        std::fs::write(cache.join("active.t0.pcm"), b"x").unwrap();
        std::fs::write(cache.join("finished.mix.pcm"), b"x").unwrap();
        std::fs::write(cache.join("not-a-pcm-file.txt"), b"x").unwrap();

        clear_stale_pcm_cache(&db, &paths).unwrap();

        assert!(cache.join("active.t0.pcm").exists(), "cache backing a non-terminal row must survive");
        assert!(!cache.join("finished.mix.pcm").exists(), "orphaned cache entries must be swept");
        assert!(cache.join("not-a-pcm-file.txt").exists(), "unrelated files must be left alone");
    }
}
