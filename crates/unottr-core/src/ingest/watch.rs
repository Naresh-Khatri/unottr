//! notify (inotify) `CLOSE_WRITE` + periodic scan, three-stage completion detection, and the
//! missing-file/fingerprint sweep. Runs on its own thread; talks to the worker only through
//! `jobs`/`events` channels and the db (04-ingest.md).

use std::collections::HashMap;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::thread;
use std::time::Instant;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tracing::debug;

use crate::cancel::CancelToken;
use crate::db::recordings;
use crate::db::watch_folders::{self, WatchFolder};
use crate::media::MediaBackend;
use crate::Database;

use super::config::IngestConfig;
use super::fingerprint;
use super::Event;

/// A file seen in a watched folder but not yet promoted to a `recordings` row: still being
/// written, or waiting out the bounded ffprobe retries.
struct Candidate {
    last_size: u64,
    stable_ticks: u32,
    probe_checks: u32,
}

pub fn run(
    db: Database,
    backend: Box<dyn MediaBackend>,
    cfg: IngestConfig,
    jobs: Sender<i64>,
    events: Sender<Event>,
    cancel: CancelToken,
) {
    let (fs_tx, fs_rx): (Sender<PathBuf>, Receiver<PathBuf>) = channel();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            for p in ev.paths {
                let _ = fs_tx.send(p);
            }
        }
    })
    .ok();

    let mut watched: HashSet<PathBuf> = HashSet::new();
    let mut candidates: HashMap<PathBuf, Candidate> = HashMap::new();
    // forces a full scan on the very first tick (startup scan requirement)
    let mut last_rescan = Instant::now().checked_sub(cfg.rescan_interval).unwrap_or_else(Instant::now);

    loop {
        if cancel.is_cancelled() {
            break;
        }
        let Ok(conn) = db.connect() else {
            thread::sleep(cfg.stable_poll_interval);
            continue;
        };
        let folders = watch_folders::list_enabled(&conn).unwrap_or_default();

        sync_watches(watcher.as_mut(), &mut watched, &folders);

        let mut dirty: HashSet<PathBuf> = HashSet::new();
        while let Ok(p) = fs_rx.try_recv() {
            if let Some(parent) = p.parent() {
                dirty.insert(parent.to_path_buf());
            }
        }

        let full_rescan = last_rescan.elapsed() >= cfg.rescan_interval;
        if full_rescan {
            dirty.extend(folders.iter().map(|f| f.path.clone()));
            last_rescan = Instant::now();
        }
        for folder in &folders {
            if dirty.contains(&folder.path) {
                relist(&folder.path, &cfg, &conn, &mut candidates);
            }
        }

        step_candidates(&conn, backend.as_ref(), &cfg, &mut candidates, &jobs, &events);

        if full_rescan {
            sweep_missing(&conn, &folders);
        }

        drop(conn);
        thread::sleep(cfg.stable_poll_interval);
    }
}

/// Idempotent: (re)watching an already-watched path is a cheap no-op for inotify. Folders no
/// longer enabled are unwatched; folders that don't exist yet (or were deleted and not yet
/// recreated) just fail silently and get retried next tick, and are caught regardless by the
/// periodic full rescan.
fn sync_watches(watcher: Option<&mut RecommendedWatcher>, watched: &mut HashSet<PathBuf>, folders: &[WatchFolder]) {
    let Some(watcher) = watcher else { return };
    let live: HashSet<&PathBuf> = folders.iter().map(|f| &f.path).collect();
    watched.retain(|p| {
        if !live.contains(p) {
            let _ = watcher.unwatch(p);
            false
        } else {
            true
        }
    });
    for folder in folders {
        if watcher.watch(&folder.path, RecursiveMode::NonRecursive).is_ok() {
            watched.insert(folder.path.clone());
        }
    }
}

/// One folder's current listing against the db and the in-flight candidate set. Non-recursive,
/// per spec.
fn relist(folder: &Path, cfg: &IngestConfig, conn: &rusqlite::Connection, candidates: &mut HashMap<PathBuf, Candidate>) {
    let Ok(entries) = fs::read_dir(folder) else {
        // folder deleted out from under us — periodic rescan notices it reappear later
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || !cfg.has_extension(&path) {
            continue;
        }
        match recordings::find_by_path(conn, &path) {
            Ok(Some(id)) => {
                // reappeared at the exact path it was last known at (not a move)
                let _ = recordings::restore_if_unavailable(conn, id);
            }
            Ok(None) => {
                candidates.entry(path).or_insert_with(|| Candidate { last_size: 0, stable_ticks: 0, probe_checks: 0 });
            }
            Err(_) => {}
        }
    }
}

fn step_candidates(
    conn: &rusqlite::Connection,
    backend: &dyn MediaBackend,
    cfg: &IngestConfig,
    candidates: &mut HashMap<PathBuf, Candidate>,
    jobs: &Sender<i64>,
    events: &Sender<Event>,
) {
    let mut ready = Vec::new();
    candidates.retain(|path, cand| {
        let Ok(meta) = fs::metadata(path) else {
            return false; // vanished before it finished writing
        };
        let size = meta.len();
        if size != cand.last_size {
            cand.last_size = size;
            cand.stable_ticks = 0;
            cand.probe_checks = 0;
            return true;
        }
        cand.stable_ticks += 1;
        if cand.stable_ticks < cfg.stable_required_count {
            return true;
        }
        match backend.probe(path) {
            Ok(_) => {
                ready.push(path.clone());
                false
            }
            Err(_) => {
                cand.probe_checks += 1;
                if cand.probe_checks >= cfg.max_probe_checks {
                    // stop waiting — let it reach `probing` for real so it fails visibly
                    // instead of sitting in watcher limbo forever
                    ready.push(path.clone());
                    false
                } else {
                    true
                }
            }
        }
    });
    for path in ready {
        promote(conn, &path, jobs, events);
    }
}

/// Size-stable and (probably) probeable: fingerprint it and either re-link an existing row
/// (moved/renamed file) or insert a fresh `discovered` row and hand it to the worker.
fn promote(conn: &rusqlite::Connection, path: &Path, jobs: &Sender<i64>, events: &Sender<Event>) {
    let Ok(fp) = fingerprint::compute(path) else {
        // file vanished right at the finish line; next relist re-tracks it if it comes back
        return;
    };
    match recordings::find_by_fingerprint(conn, fp.size, &fp.head, &fp.tail) {
        Ok(Some(id)) => {
            let _ = recordings::relink(conn, id, path);
        }
        Ok(None) => match recordings::insert_discovered(conn, path, fp.size, &fp.head, &fp.tail) {
            Ok(id) => {
                let _ = events.send(Event::Discovered { recording_id: id });
                let _ = jobs.send(id);
            }
            Err(e) => debug!(?e, "failed to insert discovered recording"),
        },
        Err(e) => debug!(?e, "fingerprint lookup failed"),
    }
}

/// Rows whose file vanished from its last known path. Before giving up, search every enabled
/// watch folder's current contents for a fingerprint match (a same-tick move that hasn't made
/// it through the stability window as a fresh candidate yet).
fn sweep_missing(conn: &rusqlite::Connection, folders: &[WatchFolder]) {
    let missing: Vec<(i64, PathBuf)> = recordings::available_paths(conn)
        .unwrap_or_default()
        .into_iter()
        .filter(|(_, p)| fs::metadata(p).is_err())
        .collect();

    for (id, old_path) in missing {
        let Ok(Some((size, head, tail))) = recordings::fingerprint_of(conn, id) else {
            continue;
        };
        let found = folders.iter().find_map(|folder| {
            let entries = fs::read_dir(&folder.path).ok()?;
            entries.flatten().map(|e| e.path()).find(|p| {
                p.is_file()
                    && fs::metadata(p).ok().map(|m| m.len()) == Some(size)
                    && fingerprint::compute(p)
                        .is_ok_and(|fp| fp.head.as_slice() == head.as_slice() && fp.tail.as_slice() == tail.as_slice())
            })
        });
        match found {
            Some(new_path) if new_path != old_path => {
                let _ = recordings::relink(conn, id, &new_path);
            }
            _ => {
                let _ = recordings::mark_unavailable(conn, id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::process::Command;
    use std::sync::mpsc::Receiver;
    use std::time::Duration;

    use super::*;
    use crate::db::recordings::Status;
    use crate::db::watch_folders::{self, WatchFolder};
    use crate::media::FfmpegCli;
    use crate::Database;

    fn temp_db() -> (tempfile::TempDir, Database) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path().join("t.db")).unwrap();
        (dir, db)
    }

    fn have_ffmpeg() -> bool {
        Command::new("ffmpeg").arg("-version").output().is_ok_and(|o| o.status.success())
    }

    /// A tiny real, valid mp4 — one video stream, one audio stream.
    fn fixture(out: &Path, seconds: u32) {
        let status = Command::new("ffmpeg")
            .args(["-v", "error", "-y"])
            .args(["-f", "lavfi", "-i", &format!("color=c=black:s=64x64:d={seconds}")])
            .args(["-f", "lavfi", "-i", &format!("sine=frequency=440:duration={seconds}")])
            .args(["-map", "0:v", "-map", "1:a", "-pix_fmt", "yuv420p"])
            .arg(out)
            .status()
            .expect("spawn ffmpeg");
        assert!(status.success(), "building fixture failed");
    }

    fn drive_to_promotion(
        conn: &rusqlite::Connection,
        backend: &dyn MediaBackend,
        cfg: &IngestConfig,
        candidates: &mut HashMap<PathBuf, Candidate>,
        jobs: &Sender<i64>,
        events: &Sender<Event>,
    ) {
        for _ in 0..(cfg.stable_required_count + cfg.max_probe_checks + 2) {
            if candidates.is_empty() {
                return;
            }
            step_candidates(conn, backend, cfg, candidates, jobs, events);
        }
    }

    #[test]
    fn a_growing_file_is_not_promoted_until_size_is_stable() {
        if !have_ffmpeg() {
            return;
        }
        let (_d, db) = temp_db();
        let conn = db.connect().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let complete = dir.path().join("complete.mp4");
        fixture(&complete, 1);
        let whole = fs::read(&complete).unwrap();

        let growing = dir.path().join("growing.mp4");
        fs::write(&growing, &whole[..whole.len() / 4]).unwrap();

        let backend = FfmpegCli::discover();
        let cfg = IngestConfig { stable_required_count: 2, max_probe_checks: 2, ..Default::default() };
        let (jobs_tx, jobs_rx) = channel::<i64>();
        let (events_tx, events_rx) = channel::<Event>();
        let mut candidates = HashMap::new();
        candidates.insert(growing.clone(), Candidate { last_size: 0, stable_ticks: 0, probe_checks: 0 });

        // still writing: each tick changes the size, so it must never be promoted
        step_candidates(&conn, &backend, &cfg, &mut candidates, &jobs_tx, &events_tx);
        assert!(jobs_rx.try_recv().is_err(), "must not queue while still growing");

        fs::write(&growing, &whole[..whole.len() / 2]).unwrap();
        step_candidates(&conn, &backend, &cfg, &mut candidates, &jobs_tx, &events_tx);
        assert!(jobs_rx.try_recv().is_err(), "must not queue mid-write");

        // finish writing, then let size settle
        fs::write(&growing, &whole).unwrap();
        drive_to_promotion(&conn, &backend, &cfg, &mut candidates, &jobs_tx, &events_tx);

        let id = jobs_rx.try_recv().expect("must queue once stable and probeable");
        assert!(matches!(
            events_rx.try_recv(),
            Ok(Event::Discovered { recording_id }) if recording_id == id
        ));
    }

    #[test]
    fn a_file_that_never_probes_still_escapes_watcher_limbo() {
        if !have_ffmpeg() {
            return;
        }
        let (_d, db) = temp_db();
        let conn = db.connect().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let garbage = dir.path().join("garbage.mp4");
        fs::write(&garbage, b"not a real media file, just some bytes").unwrap();

        let backend = FfmpegCli::discover();
        let cfg = IngestConfig { stable_required_count: 1, max_probe_checks: 2, ..Default::default() };
        let (jobs_tx, jobs_rx) = channel::<i64>();
        let (events_tx, events_rx) = channel::<Event>();
        let mut candidates = HashMap::new();
        candidates.insert(garbage.clone(), Candidate { last_size: 0, stable_ticks: 0, probe_checks: 0 });

        drive_to_promotion(&conn, &backend, &cfg, &mut candidates, &jobs_tx, &events_tx);

        assert!(candidates.is_empty(), "a corrupt file must not wait forever");
        let id = jobs_rx.try_recv().expect("queued despite never probing cleanly");
        assert!(matches!(events_rx.try_recv(), Ok(Event::Discovered { recording_id }) if recording_id == id));
    }

    #[test]
    fn a_renamed_file_relinks_without_reprocessing() {
        if !have_ffmpeg() {
            return;
        }
        let (_d, db) = temp_db();
        let conn = db.connect().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old.mp4");
        fixture(&old, 1);

        let fp = fingerprint::compute(&old).unwrap();
        let id = recordings::insert_discovered(&conn, &old, fp.size, &fp.head, &fp.tail).unwrap();
        recordings::set_status(&conn, id, Status::Done, None).unwrap();

        let new = dir.path().join("new.mp4");
        fs::rename(&old, &new).unwrap();

        let backend = FfmpegCli::discover();
        let cfg = IngestConfig::default();
        let (jobs_tx, jobs_rx) = channel::<i64>();
        let (events_tx, events_rx) = channel::<Event>();
        let mut candidates = HashMap::new();
        relist(dir.path(), &cfg, &conn, &mut candidates);
        assert_eq!(candidates.len(), 1, "the renamed file is unknown at its new path");

        drive_to_promotion(&conn, &backend, &cfg, &mut candidates, &jobs_tx, &events_tx);

        assert!(jobs_rx.try_recv().is_err(), "a relink must not enqueue a job");
        assert!(events_rx.try_recv().is_err(), "a relink must not emit Discovered");
        assert_eq!(recordings::path_of(&conn, id).unwrap(), Some(new));
        assert_eq!(
            recordings::status_of(&conn, id).unwrap(),
            Some(Status::Done),
            "relink must not reset status / reprocess"
        );
    }

    #[test]
    fn a_deleted_then_restored_file_flips_availability_but_keeps_the_transcript() {
        if !have_ffmpeg() {
            return;
        }
        let (_d, db) = temp_db();
        let conn = db.connect().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let media = dir.path().join("meeting.mp4");
        fixture(&media, 1);
        let fp = fingerprint::compute(&media).unwrap();
        let id = recordings::insert_discovered(&conn, &media, fp.size, &fp.head, &fp.tail).unwrap();
        recordings::set_status(&conn, id, Status::Done, None).unwrap();

        fs::remove_file(&media).unwrap();
        let folders = [WatchFolder { id: 1, path: dir.path().to_path_buf(), track_rule: "auto".into(), enabled: true }];
        sweep_missing(&conn, &folders);

        let available: i64 = conn.query_row("SELECT available FROM recordings WHERE id = ?1", [id], |r| r.get(0)).unwrap();
        assert_eq!(available, 0, "vanished file must be marked unavailable");
        assert_eq!(
            recordings::status_of(&conn, id).unwrap(),
            Some(Status::Done),
            "deletion must never touch the transcript / status"
        );

        // restored at the exact same path
        fixture(&media, 1);
        let mut candidates = HashMap::new();
        relist(dir.path(), &IngestConfig::default(), &conn, &mut candidates);

        let available: i64 = conn.query_row("SELECT available FROM recordings WHERE id = ?1", [id], |r| r.get(0)).unwrap();
        assert_eq!(available, 1, "reappearing at the same path must restore availability");
        assert_eq!(recordings::status_of(&conn, id).unwrap(), Some(Status::Done));
    }

    fn recv_discovered(rx: &Receiver<Event>, timeout: Duration) -> Option<i64> {
        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return None;
            }
            if let Ok(Event::Discovered { recording_id }) = rx.recv_timeout(left.min(Duration::from_millis(200))) {
                return Some(recording_id);
            }
        }
    }

    #[test]
    fn the_watcher_thread_survives_a_watched_folder_being_deleted_and_recreated() {
        if !have_ffmpeg() {
            return;
        }
        let (_d, db) = temp_db();
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("watched");
        fs::create_dir_all(&folder).unwrap();
        {
            let conn = db.connect().unwrap();
            watch_folders::add(&conn, &folder).unwrap();
        }

        let backend: Box<dyn MediaBackend> = Box::new(FfmpegCli::discover());
        let cfg = IngestConfig {
            stable_poll_interval: Duration::from_millis(50),
            stable_required_count: 2,
            max_probe_checks: 2,
            rescan_interval: Duration::from_millis(200),
            ..Default::default()
        };
        let (jobs_tx, _jobs_rx) = channel::<i64>();
        let (events_tx, events_rx) = channel::<Event>();
        let cancel = CancelToken::new();

        let handle = {
            let db = db.clone();
            let cfg = cfg.clone();
            let cancel = cancel.clone();
            thread::spawn(move || run(db, backend, cfg, jobs_tx, events_tx, cancel))
        };

        fixture(&folder.join("first.mp4"), 1);
        let first_id = recv_discovered(&events_rx, Duration::from_secs(15)).expect("first file discovered");

        fs::remove_dir_all(&folder).unwrap();
        thread::sleep(Duration::from_millis(300));
        fs::create_dir_all(&folder).unwrap();
        fixture(&folder.join("second.mp4"), 2);

        let second_id =
            recv_discovered(&events_rx, Duration::from_secs(15)).expect("second file discovered after recreate");
        assert_ne!(first_id, second_id);

        cancel.cancel();
        handle.join().unwrap();
    }
}
