//! The serial pipeline worker. Concurrency 1 on purpose — whisper on the gpu saturates the
//! device, so a second job just thrashes vram and both finish later (04-ingest.md).

use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::time::Duration;

use tracing::{info, warn};

use crate::cancel::CancelToken;
use crate::db::recordings::{self, Status};
use crate::error::Error;
use crate::media::MediaBackend;
use crate::model::ModelStore;
use crate::paths::Paths;
use crate::Database;

use super::pipeline::{self, PipelineConfig, PipelineCtx};
use super::Event;

/// Everything a job needs that isn't per-call (id/events/cancel) — bundled so `run` stays
/// under clippy's argument-count lint instead of an `#[allow]`.
pub struct WorkerCtx {
    pub db: Database,
    pub paths: Paths,
    pub backend: Box<dyn MediaBackend>,
    pub store: ModelStore,
    pub cfg: PipelineConfig,
    pub max_attempts: i64,
    /// When true, re-read `PipelineConfig` from the `settings` table before every job instead
    /// of running with `cfg` forever — lets the tauri app honour a settings change on the
    /// very next job with no service restart. The cli's explicit `--device`/`--model` flags
    /// have no settings table backing them, so it always leaves this false.
    pub settings_aware: bool,
}

pub fn run(ctx: WorkerCtx, jobs: Receiver<i64>, events: Sender<Event>, cancel: CancelToken) {
    // polls rather than blocking on `recv()` so an idle worker still notices cancellation —
    // a blocking recv only wakes on a job or every sender dropping, neither of which shutdown
    // guarantees on its own
    loop {
        if cancel.is_cancelled() {
            break;
        }
        match jobs.recv_timeout(Duration::from_millis(250)) {
            Ok(id) => run_with_retries(&ctx, id, &events, &cancel),
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

fn run_with_retries(ctx: &WorkerCtx, id: i64, events: &Sender<Event>, cancel: &CancelToken) {
    // fresh per-job read, not cached on ctx: a settings change must reach the very next job,
    // and re-reading here (rather than pushing changes into a running WorkerCtx) keeps the
    // worker thread free of any shared-mutable-config plumbing
    let live_cfg;
    let cfg = if ctx.settings_aware {
        live_cfg = ctx
            .db
            .connect()
            .and_then(|conn| crate::db::settings::pipeline_config(&conn))
            .unwrap_or_else(|e| {
                warn!(error = %e, "could not read settings; using the last known pipeline config");
                ctx.cfg.clone()
            });
        &live_cfg
    } else {
        &ctx.cfg
    };
    let pctx = PipelineCtx {
        db: &ctx.db,
        paths: &ctx.paths,
        backend: ctx.backend.as_ref(),
        store: &ctx.store,
        cfg,
    };
    // whether this job has already used its one automatic gpu-oom-then-cpu retry — read
    // back rather than assumed false, in case a previous run already forced cpu for this
    // recording (persisted, see `recordings::force_cpu_of`), so we don't retry-in-place twice
    let mut already_forced_cpu = ctx
        .db
        .connect()
        .and_then(|conn| recordings::force_cpu_of(&conn, id))
        .unwrap_or(false);
    loop {
        let on_progress = |stage: Status, pct: f32| {
            let _ = events.send(Event::Progress { recording_id: id, stage, pct });
        };
        match pipeline::process_recording(&pctx, id, cancel, &on_progress) {
            Ok(()) => {
                info!(recording_id = id, "job done");
                let _ = events.send(Event::Done { recording_id: id });
                return;
            }
            Err(Error::Cancelled) => {
                // graceful shutdown: leave status/checkpoint exactly as they are, the next
                // startup's reconciliation picks this row back up
                info!(recording_id = id, "job interrupted by shutdown");
                return;
            }
            // 07's GpuOom decision: silent to the user, one automatic cpu retry. Bypasses
            // `fail_or_retry` entirely — this isn't a normal failure/attempt, it's a
            // transparent device switch.
            Err(Error::GpuOom) if !already_forced_cpu => {
                warn!(
                    recording_id = id,
                    "gpu ran out of memory transcribing this recording; falling back to cpu \
                     and retrying once (if this fires often, the default model tier is too \
                     big for this gpu)"
                );
                already_forced_cpu = true;
                if let Err(e) = ctx
                    .db
                    .connect()
                    .and_then(|conn| recordings::set_force_cpu(&conn, id, true))
                {
                    warn!(recording_id = id, error = %e, "failed to persist cpu fallback");
                }
                continue;
            }
            Err(e) => {
                let slug = e.slug();
                warn!(recording_id = id, error = slug, "job failed");
                let will_retry = ctx
                    .db
                    .connect()
                    .and_then(|conn| recordings::fail_or_retry(&conn, id, &e, ctx.max_attempts))
                    .unwrap_or(false);
                if will_retry {
                    continue;
                }
                let _ = events.send(Event::Failed { recording_id: id, error: slug.to_string() });
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::process::Command;
    use std::sync::mpsc::channel;

    use super::*;
    use crate::media::FfmpegCli;
    use crate::model::ModelStore;
    use crate::paths::Paths;

    fn have_ffmpeg() -> bool {
        Command::new("ffmpeg").arg("-version").output().is_ok_and(|o| o.status.success())
    }

    fn temp_db() -> (tempfile::TempDir, Database) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path().join("t.db")).unwrap();
        (dir, db)
    }

    /// A file that fails to probe -> `process_recording` errors before any model is ever
    /// touched, so this needs no whisper/embedding model to be present. `garbage.mp4`'s
    /// exact ffprobe error (and so its slug/retry policy — `truncated` is `Terminal`,
    /// `probe_failed` is `Bounded`) depends on the installed ffmpeg's wording, so this
    /// accepts either but checks the attempt count matches whichever policy actually fired.
    #[test]
    fn a_garbage_file_fails_with_a_typed_error_and_the_right_attempt_count() {
        if !have_ffmpeg() {
            return;
        }
        let (_d, db) = temp_db();
        let conn = db.connect().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let garbage = dir.path().join("garbage.mp4");
        std::fs::write(&garbage, b"not a real media file, just some bytes").unwrap();
        let id = recordings::stub(&conn, &garbage, None).unwrap();
        drop(conn);

        let paths_dir = tempfile::tempdir().unwrap();
        let paths = Paths::for_test(paths_dir.path());
        let ctx = WorkerCtx {
            db: db.clone(),
            paths,
            backend: Box::new(FfmpegCli::discover()),
            store: ModelStore::new(dir.path().join("models")),
            cfg: PipelineConfig::default(),
            max_attempts: 2,
            settings_aware: false,
        };
        let (events_tx, events_rx) = channel::<Event>();
        let cancel = CancelToken::new();

        run_with_retries(&ctx, id, &events_tx, &cancel);

        let mut failed = None;
        while let Ok(ev) = events_rx.try_recv() {
            if let Event::Failed { recording_id, error } = ev {
                failed = Some((recording_id, error));
            }
        }
        let (failed_id, error) = failed.expect("must emit Failed eventually");
        assert_eq!(failed_id, id);
        assert!(
            error == "truncated" || error == "probe_failed",
            "expected a probe-stage error slug, got {error}"
        );

        let conn = db.connect().unwrap();
        assert_eq!(recordings::status_of(&conn, id).unwrap(), Some(Status::Failed));
        let attempts: i64 = conn
            .query_row("SELECT attempts FROM recordings WHERE id = ?1", [id], |r| r.get(0))
            .unwrap();
        // truncated is Terminal (parks on the first failure); probe_failed is Bounded and
        // parks once max_attempts (2, from ctx above) is reached
        let expected = if error == "truncated" { 1 } else { 2 };
        assert_eq!(attempts, expected, "attempt count must match {error}'s retry policy");
    }
}
