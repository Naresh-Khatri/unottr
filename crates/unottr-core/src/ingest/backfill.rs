//! Backfilling a folder added after files already exist in it: report what's there and do
//! nothing else until explicitly confirmed (04-ingest.md). `confirm` only ever inserts
//! `discovered` rows — an already-running `IngestService::enqueue`s them, otherwise they sit
//! until the next reconciliation picks them up as non-terminal.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::db::recordings;
use crate::db::Database;
use crate::error::{IoResultExt, Result};
use crate::media::MediaBackend;

use super::config::IngestConfig;
use super::fingerprint;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BackfillEstimate {
    pub folder: PathBuf,
    pub count: usize,
    pub total_duration_ms: u64,
    pub estimated_processing_ms: u64,
}

/// Read-only: counts matching files and sums their probed duration. Unprobeable files (still
/// writing, corrupt) count toward `count` but contribute nothing to the duration estimate.
pub fn scan(folder: &Path, cfg: &IngestConfig, backend: &dyn MediaBackend) -> Result<BackfillEstimate> {
    let mut count = 0usize;
    let mut total_duration_ms = 0u64;
    let entries = fs::read_dir(folder).at(folder)?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || !cfg.has_extension(&path) {
            continue;
        }
        count += 1;
        if let Ok(probe) = backend.probe(&path) {
            total_duration_ms += probe.duration_ms.unwrap_or(0);
        }
    }
    let estimated_processing_ms = (total_duration_ms as f64 * cfg.realtime_factor) as u64;
    Ok(BackfillEstimate {
        folder: folder.to_path_buf(),
        count,
        total_duration_ms,
        estimated_processing_ms,
    })
}

/// Inserts `discovered` rows for every matching file not already known (by path or by
/// fingerprint — a moved file re-links instead). Returns the ids of freshly discovered rows;
/// re-linked files are not reprocessed, so they're not included.
pub fn confirm(db: &Database, folder: &Path, cfg: &IngestConfig) -> Result<Vec<i64>> {
    let conn = db.connect()?;
    let mut discovered = Vec::new();
    let entries = fs::read_dir(folder).at(folder)?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || !cfg.has_extension(&path) {
            continue;
        }
        if recordings::find_by_path(&conn, &path)?.is_some() {
            continue;
        }
        let Ok(fp) = fingerprint::compute(&path) else {
            continue; // vanished between scan and confirm
        };
        match recordings::find_by_fingerprint(&conn, fp.size, &fp.head, &fp.tail)? {
            Some(id) => {
                recordings::relink(&conn, id, &path)?;
            }
            None => {
                let id = recordings::insert_discovered(&conn, &path, fp.size, &fp.head, &fp.tail)?;
                discovered.push(id);
            }
        }
    }
    Ok(discovered)
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    use super::*;
    use crate::db::recordings;
    use crate::media::FfmpegCli;

    fn have_ffmpeg() -> bool {
        Command::new("ffmpeg").arg("-version").output().is_ok_and(|o| o.status.success())
    }

    fn fixture(out: &Path, seconds: u32) {
        let status = Command::new("ffmpeg")
            .args(["-v", "error", "-y"])
            .args(["-f", "lavfi", "-i", &format!("color=c=black:s=64x64:d={seconds}")])
            .args(["-f", "lavfi", "-i", &format!("sine=frequency=440:duration={seconds}")])
            .args(["-map", "0:v", "-map", "1:a", "-pix_fmt", "yuv420p"])
            .arg(out)
            .status()
            .expect("spawn ffmpeg");
        assert!(status.success());
    }

    fn temp_db() -> (tempfile::TempDir, Database) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path().join("t.db")).unwrap();
        (dir, db)
    }

    #[test]
    fn scanning_reports_an_estimate_without_touching_the_database() {
        if !have_ffmpeg() {
            return;
        }
        let (_d, db) = temp_db();
        let dir = tempfile::tempdir().unwrap();
        fixture(&dir.path().join("a.mp4"), 2);
        fixture(&dir.path().join("b.mp4"), 3);
        std::fs::write(dir.path().join("ignore.txt"), b"not media").unwrap();

        let cfg = IngestConfig::default();
        let backend = FfmpegCli::discover();
        let estimate = scan(dir.path(), &cfg, &backend).unwrap();

        assert_eq!(estimate.count, 2, "the non-matching extension must not count");
        assert!(estimate.total_duration_ms >= 4000, "got {}", estimate.total_duration_ms);
        assert!(estimate.estimated_processing_ms > 0);

        let conn = db.connect().unwrap();
        assert_eq!(recordings::non_terminal(&conn).unwrap().len(), 0, "scan must be read-only");
    }

    #[test]
    fn nothing_is_enqueued_until_confirm_is_called() {
        if !have_ffmpeg() {
            return;
        }
        let (_d, db) = temp_db();
        let dir = tempfile::tempdir().unwrap();
        fixture(&dir.path().join("a.mp4"), 1);

        let cfg = IngestConfig::default();
        let backend = FfmpegCli::discover();
        scan(dir.path(), &cfg, &backend).unwrap();
        {
            let conn = db.connect().unwrap();
            assert_eq!(recordings::non_terminal(&conn).unwrap().len(), 0, "must do nothing until confirmed");
        }

        let ids = confirm(&db, dir.path(), &cfg).unwrap();
        assert_eq!(ids.len(), 1);
        let conn = db.connect().unwrap();
        assert_eq!(recordings::non_terminal(&conn).unwrap(), ids);

        // confirming again must not double-insert or reprocess
        let again = confirm(&db, dir.path(), &cfg).unwrap();
        assert!(again.is_empty(), "already-known file must not be re-discovered");
    }
}
