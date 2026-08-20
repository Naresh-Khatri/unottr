// The one live IngestService, and the src-tauri/src/lib.rs setup that built it: settings ->
// ffmpeg cli -> cache override -> service -> events. Kept apart from index.ts so the service
// itself stays constructible in a test without electron's app/window singletons.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { db } from "../db";
import { load } from "../db/settings";
import { events } from "../events";
import { check, fromSettings } from "../media/ffmpeg";
import { modelsDir, pcmCacheDir } from "../paths";
import { thumbsDirFor } from "../media/thumbs";
import { IngestService } from ".";
import type { IngestEvent } from "./queue";

let service: IngestService | null = null;

export const ingest = (): IngestService | null => service;

export function startIngest(): void {
  if (service) return;
  const s = load(db());
  const cli = fromSettings(s.ffmpeg_path, s.ffprobe_path);
  // preflight is never fatal to startup — a missing ffmpeg just means every job parks with a
  // typed, retryable error, and the ui reads `get_settings().ffmpeg_ok` for its banner
  if (!check(cli)) console.warn("ffmpeg/ffprobe not usable at startup; jobs will park until fixed");

  // the settings override relocates only the pcm/thumbs caches; data and state stay put
  const cacheDir = s.cache_dir ? join(s.cache_dir, "pcm") : pcmCacheDir();
  const thumbsDir = thumbsDirFor(s.cache_dir);
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(thumbsDir, { recursive: true });

  service = IngestService.start({
    db: db(),
    cli,
    cacheDir,
    thumbsDir,
    modelsDir: modelsDir(),
    settingsAware: true,
    onEvent: forward,
  });
}

/** Blocks the exit path on the running job reaching its next checkpoint. */
export async function stopIngest(): Promise<void> {
  const running = service;
  service = null;
  await running?.shutdown();
}

/** Queue concurrency is 1, so `active` only ever reaches 0 or 1 — `total` is the queue depth
 *  including the job in flight. Same accounting as the rust `update_job_count`. */
let jobs = { active: 0, total: 0 };
let statusSink: ((active: number, total: number) => void) | null = null;

/** The tray's status line subscribes here; nothing else needs the counts. */
export function onJobCounts(fn: (active: number, total: number) => void): void {
  statusSink = fn;
}

function count(e: IngestEvent): void {
  if (e.kind === "discovered") jobs.total += 1;
  else if (e.kind === "progress") jobs.active = 1;
  else jobs = { active: 0, total: Math.max(0, jobs.total - 1) };
  statusSink?.(jobs.active, jobs.total);
}

function forward(e: IngestEvent): void {
  count(e);
  switch (e.kind) {
    case "discovered":
      return events.recordingDiscovered({ recording_id: e.recording_id });
    case "progress":
      return events.jobProgress({ recording_id: e.recording_id, stage: e.stage, pct: e.pct });
    case "done":
      return events.jobDone({ recording_id: e.recording_id });
    case "failed":
      return events.jobFailed({ recording_id: e.recording_id, error: e.error });
  }
}
