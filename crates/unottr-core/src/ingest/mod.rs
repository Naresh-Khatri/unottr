//! Public surface for the future Tauri layer: `IngestService` owns the watcher + worker
//! threads and speaks the 05-ipc-contract.md event shapes over a channel.

pub mod backfill;
pub mod config;
pub mod fingerprint;
pub mod pipeline;
mod reconcile;
mod watch;
mod worker;

pub use config::{IngestConfig, DEFAULT_EXTENSIONS};
pub use pipeline::PipelineConfig;

use std::sync::mpsc::{self, Receiver};
use std::thread::{self, JoinHandle};

use serde::Serialize;

use crate::cancel::CancelToken;
use crate::db::recordings::Status;
use crate::db::Database;
use crate::error::Result;
use crate::media::{FfmpegCli, MediaBackend};
use crate::model::ModelStore;
use crate::paths::Paths;

/// Mirrors 05-ipc-contract.md's `job_progress`/`job_done`/`job_failed`/`recording_discovered`
/// payloads. The tauri layer forwards each variant onto its own ipc event of the same name.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Event {
    Discovered { recording_id: i64 },
    Progress { recording_id: i64, stage: Status, pct: f32 },
    Done { recording_id: i64 },
    Failed { recording_id: i64, error: String },
}

/// Owns the watcher and worker threads. Dropping this without calling `shutdown` leaves the
/// threads running detached — always shut down explicitly (or via `cancel` + your own join).
pub struct IngestService {
    cancel: CancelToken,
    job_tx: mpsc::Sender<i64>,
    watch_handle: JoinHandle<()>,
    worker_handle: JoinHandle<()>,
}

impl IngestService {
    /// Runs startup reconciliation synchronously — every non-terminal row is (re)queued before
    /// this returns — then spawns the watcher and worker threads. The returned `Receiver`
    /// yields every `Event` the pipeline produces from here on. `settings_aware` controls
    /// whether the worker re-reads `PipelineConfig` from the `settings` table before each
    /// job (the tauri app) or runs with `pipeline_cfg` for its whole lifetime (the cli, whose
    /// config comes from explicit flags with no settings table backing).
    pub fn start(
        db: Database,
        paths: Paths,
        backend: FfmpegCli,
        store: ModelStore,
        cfg: IngestConfig,
        pipeline_cfg: PipelineConfig,
        settings_aware: bool,
    ) -> Result<(Self, Receiver<Event>)> {
        let cancel = CancelToken::new();
        let (job_tx, job_rx) = mpsc::channel::<i64>();
        let (event_tx, event_rx) = mpsc::channel::<Event>();

        reconcile::clear_stale_pcm_cache(&db, &paths)?;
        for id in reconcile::run(&db)? {
            let _ = job_tx.send(id);
        }

        let watch_handle = {
            let db = db.clone();
            let backend: Box<dyn MediaBackend> = Box::new(backend.clone());
            let cfg = cfg.clone();
            let job_tx = job_tx.clone();
            let event_tx = event_tx.clone();
            let cancel = cancel.clone();
            thread::spawn(move || watch::run(db, backend, cfg, job_tx, event_tx, cancel))
        };

        let worker_handle = {
            let backend: Box<dyn MediaBackend> = Box::new(backend);
            let max_attempts = cfg.max_attempts;
            let cancel = cancel.clone();
            let worker_ctx =
                worker::WorkerCtx { db, paths, backend, store, cfg: pipeline_cfg, max_attempts, settings_aware };
            thread::spawn(move || worker::run(worker_ctx, job_rx, event_tx, cancel))
        };

        Ok((Self { cancel, job_tx, watch_handle, worker_handle }, event_rx))
    }

    /// A clonable handle to the same cancellation flag, e.g. for a ctrl-c handler that needs
    /// to trigger shutdown without holding `&IngestService` past the handler's `'static` bound.
    pub fn cancel_handle(&self) -> CancelToken {
        self.cancel.clone()
    }

    /// Hands a recording id straight to the worker — for `backfill::confirm`'s freshly
    /// inserted `discovered` rows, so a currently running service picks them up immediately
    /// instead of waiting for the next restart's reconciliation.
    pub fn enqueue(&self, recording_id: i64) {
        let _ = self.job_tx.send(recording_id);
    }

    /// Signals shutdown without blocking. Threads exit at their next checkpoint; call
    /// `shutdown` (or join the handles yourself) to actually wait for that.
    pub fn cancel(&self) {
        self.cancel.cancel();
    }

    /// Cancels (if not already) and blocks until both threads exit. The worker finishes its
    /// current chunk and checkpoints before returning (04-ingest.md graceful shutdown).
    pub fn shutdown(self) {
        self.cancel.cancel();
        let _ = self.watch_handle.join();
        let _ = self.worker_handle.join();
    }
}
