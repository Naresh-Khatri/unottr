// Port of crates/unottr-core/src/ingest/config.rs, plus rust's `db::settings::pipeline_config`
// (it lives here rather than in db/settings.ts: ingest reads settings, settings never reads
// ingest, and PipelineConfig is only ever consumed by a job).

import { extname } from "node:path";
import type { Device } from "../../shared/ipc";
import type { Db } from "../db/client";
import { load, tierToModelName } from "../db/settings";

/** Containers worth watching for. Anything ffmpeg can open, that a meeting recorder emits. */
export const DEFAULT_EXTENSIONS = [
  "mkv",
  "mp4",
  "mov",
  "webm",
  "m4a",
  "mp3",
  "wav",
  "flac",
  "ogg",
  "opus",
  "avi",
  "ts",
  "flv",
];

export interface IngestConfig {
  extensions: string[];
  /** One watcher tick; also chokidar's `awaitWriteFinish.pollInterval`. */
  stablePollIntervalMs: number;
  /** Identical-size ticks before a rescan-found file is probed. */
  stableRequiredCount: number;
  /** Failed probes tolerated after the size settles, then it is queued anyway so it fails
   *  visibly instead of sitting in watcher limbo forever. */
  maxProbeChecks: number;
  /** Catches anything inotify missed, and drives the missing-file sweep. */
  rescanIntervalMs: number;
  maxAttempts: number;
  /** Measured wall-clock / audio-duration, for the backfill estimate. */
  realtimeFactor: number;
}

export const defaultIngestConfig = (): IngestConfig => ({
  extensions: [...DEFAULT_EXTENSIONS],
  stablePollIntervalMs: 2_000,
  stableRequiredCount: 15,
  maxProbeChecks: 5,
  rescanIntervalMs: 30_000,
  maxAttempts: 3,
  realtimeFactor: 0.6,
});

export function hasExtension(cfg: IngestConfig, path: string): boolean {
  const ext = extname(path).slice(1).toLowerCase();
  return ext !== "" && cfg.extensions.some((e) => e.toLowerCase() === ext);
}

/** chokidar's write-finish window = the same span rust spent counting stable ticks. */
export const awaitWriteFinish = (cfg: IngestConfig) => ({
  stabilityThreshold: cfg.stablePollIntervalMs * cfg.stableRequiredCount,
  pollInterval: cfg.stablePollIntervalMs,
});

export interface PipelineConfig {
  device: Device;
  threads: number | null;
  language: string | null;
  /** Model name from the catalog; null picks the device-appropriate default. */
  whisperModel: string | null;
  embeddingModel: string | null;
  diarizeThreshold: number | null;
  diarizeSpeakers: number | null;
  /** Fetch whisper/segmentation/embedding models if missing rather than erroring. VAD is
   *  always auto-fetched regardless — small enough that asking first would be theatre. */
  downloadModels: boolean;
}

export const defaultPipelineConfig = (): PipelineConfig => ({
  device: "auto",
  threads: null,
  language: null,
  whisperModel: null,
  embeddingModel: null,
  diarizeThreshold: null,
  diarizeSpeakers: null,
  downloadModels: false,
});

/** Read fresh before every job so a settings change reaches the very next one. */
export function pipelineConfig(db: Db): PipelineConfig {
  const s = load(db);
  return {
    ...defaultPipelineConfig(),
    device: s.device,
    whisperModel: tierToModelName(s.model_tier),
    language: s.language,
    diarizeThreshold: s.diarize_threshold,
  };
}
