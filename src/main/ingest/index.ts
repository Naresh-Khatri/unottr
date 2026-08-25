// Port of crates/unottr-core/src/ingest/mod.rs: owns the watcher and the serial queue, and
// emits the 05-ipc-contract.md event shapes. The caller maps them onto `events.*`.

import type { Db } from "../db/client";
import type { FfmpegCli } from "../media/ffmpeg";
import { modelsDir as defaultModelsDir, pcmCacheDir, thumbsCacheDir } from "../paths";
import {
  type IngestConfig,
  type PipelineConfig,
  defaultIngestConfig,
  defaultPipelineConfig,
  pipelineConfig,
} from "./config";
import { type JobCtx, processRecording, rediarizeRecording } from "./job";
import { type IngestEvent, type JobSpec, Queue } from "./queue";
import { clearStalePcmCache, run as reconcileRun } from "./reconcile";
import { Watcher } from "./watch";

export type { IngestEvent, JobSpec } from "./queue";

export interface ServiceOptions {
  db: Db;
  cli: FfmpegCli;
  onEvent: (event: IngestEvent) => void;
  cacheDir?: string;
  thumbsDir?: string;
  modelsDir?: string;
  cfg?: IngestConfig;
  /** The config every job runs with when `settingsAware` is false. */
  pipelineCfg?: PipelineConfig;
  /** Re-read `PipelineConfig` from the settings table before each job, so a settings change
   *  reaches the very next one with no service restart. */
  settingsAware?: boolean;
}

export class IngestService {
  private constructor(
    private readonly queue: Queue,
    private readonly watcher: Watcher,
  ) {}

  /**
   * Runs startup reconciliation synchronously — every non-terminal row is requeued before this
   * returns — then starts the watcher.
   */
  static start(o: ServiceOptions): IngestService {
    const cfg = o.cfg ?? defaultIngestConfig();
    const cacheDir = o.cacheDir ?? pcmCacheDir();
    const thumbsDir = o.thumbsDir ?? thumbsCacheDir();
    const modelsDir = o.modelsDir ?? defaultModelsDir();
    const fallback = o.pipelineCfg ?? defaultPipelineConfig();

    const ctxFor = (): JobCtx => ({
      db: o.db,
      cli: o.cli,
      cacheDir,
      thumbsDir,
      modelsDir,
      cfg: o.settingsAware ? live(o.db, fallback) : fallback,
    });

    const queue = new Queue({
      db: o.db,
      maxAttempts: cfg.maxAttempts,
      sourcePollIntervalMs: cfg.stablePollIntervalMs,
      sourceStableCount: cfg.stableRequiredCount,
      run: (id, spec, onProgress, signal) =>
        spec.kind === "rediarize"
          ? rediarizeRecording(ctxFor(), id, spec.speakers, onProgress, signal)
          : processRecording(ctxFor(), id, onProgress, signal),
      onEvent: o.onEvent,
    });

    clearStalePcmCache(o.db, cacheDir);
    for (const id of reconcileRun(o.db)) queue.enqueue(id);

    const watcher = new Watcher({
      db: o.db,
      cli: o.cli,
      cfg,
      onDiscovered: (id) => {
        o.onEvent({ kind: "discovered", recording_id: id });
        queue.enqueue(id);
      },
    });
    watcher.start();

    return new IngestService(queue, watcher);
  }

  /** For backfill's freshly inserted rows and the ui's retry, so a running service picks them
   *  up immediately instead of waiting for the next startup. */
  enqueue(id: number, spec?: JobSpec): void {
    this.queue.enqueue(id, spec);
  }

  /** The running job finishes its current chunk and checkpoints before this resolves. */
  async shutdown(): Promise<void> {
    await Promise.all([this.watcher.shutdown(), this.queue.shutdown()]);
  }
}

function live(db: Db, fallback: PipelineConfig): PipelineConfig {
  try {
    return pipelineConfig(db);
  } catch {
    return fallback; // unreadable settings must not stall the queue
  }
}
