// One recording, start to finish. Port of crates/unottr-core/src/ingest/pipeline.rs (the name
// `pipeline.ts` was already taken by the transcribe/diarize database driver this calls into).
//
// Always runs the full sequence regardless of which non-terminal status it entered at — see
// reconcile.ts for why that is simpler and just as correct as resuming at the failed stage.

import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, parse } from "node:path";
import type { Status } from "../../shared/ipc";
import { DEFAULT_THRESHOLD } from "../../worker/cluster";
import type { Db } from "../db/client";
import { forceCpuOf, pathOf, setProbeResult, setStatus } from "../db/recordings";
import { findByPath as folderByPath } from "../db/watch-folders";
import { err } from "../errors";
import { type FfmpegCli, extractPcm, probe } from "../media/ffmpeg";
import { mixPcm } from "../media/pcm";
import { AUTO, type TrackRule, parseRule, select } from "../media/track";
import {
  type ModelSpec,
  SEGMENTATION,
  VAD,
  defaultEmbedding,
  defaultWhisper,
  findEmbedding,
  findWhisper,
} from "../models/catalog";
import { resolve as resolveDevice } from "../models/device";
import { ensure, isPresent, locate } from "../models/download";
import type { PipelineConfig } from "./config";
import { diarize, transcribe } from "./pipeline";

export interface JobCtx {
  db: Db;
  cli: FfmpegCli;
  cacheDir: string;
  modelsDir: string;
  cfg: PipelineConfig;
}

export type OnProgress = (stage: Status, pct: number) => void;

/** `{stem}.t{n}.pcm` in the cache dir — the name reconcile.ts's stale sweep parses back. */
export const pcmPathFor = (cacheDir: string, source: string, audioIndex: number): string =>
  join(cacheDir, `${parse(source).name}.t${audioIndex}.pcm`);

export async function processRecording(
  ctx: JobCtx,
  id: number,
  onProgress: OnProgress,
  signal?: AbortSignal,
): Promise<void> {
  const { db, cli, cacheDir, cfg } = ctx;
  check(signal);
  const path = pathOf(db, id);
  if (path === null) throw err.probe("", `recording ${id} vanished from the database`);

  // --- probing ---
  setStatus(db, id, "probing");
  onProgress("probing", 0);
  const probed = await probe(cli, path);
  setProbeResult(db, id, probed.container, probed.duration_ms);
  onProgress("probing", 1);

  const choice = select(probed, owningTrackRule(db, path));

  // --- extracting ---
  setStatus(db, id, "extracting");
  const extractTrack = async (audioIndex: number): Promise<string> => {
    const out = pcmPathFor(cacheDir, path, audioIndex);
    // an existing file is a finished one (extractPcm discards its output on failure), which
    // makes a retry's extract stage a no-op
    if (existsSync(out)) return out;
    await extractPcm(cli, path, {
      audioIndex,
      out,
      onProgress: (f) => onProgress("extracting", f),
      signal,
    });
    return out;
  };

  let mainPcm: string;
  let micPcm: string | null = null;
  if (choice.selection.kind === "blind") {
    mainPcm = await extractTrack(choice.selection.stream);
  } else {
    const mic = await extractTrack(choice.selection.mic);
    const desktop = await extractTrack(choice.selection.desktop);
    const mix = join(cacheDir, `${parse(path).name}.mix.pcm`);
    if (!existsSync(mix)) mixPcm([mic, desktop], mix);
    mainPcm = mix;
    micPcm = mic;
  }
  onProgress("extracting", 1);

  // --- transcribing (checkpointed inside transcribe) ---
  // a prior run may have gpu-oom'd (the queue's fallback persists this) — read it back so
  // the override survives a restart, not just the one automatic in-process retry
  const devicePref = forceCpuOf(db, id) ? "cpu" : cfg.device;
  const device = resolveDevice(devicePref);
  const whisperSpec = cfg.whisperModel
    ? (findWhisper(cfg.whisperModel) ?? raise(cfg.whisperModel))
    : defaultWhisper(device === "gpu");
  const whisperModel = await fetchModel(ctx, whisperSpec, cfg.downloadModels, signal);
  const vadModel = await fetchModel(ctx, VAD, true, signal);

  await transcribe(
    db,
    {
      recordingId: id,
      pcm: mainPcm,
      model: whisperModel,
      vadModel,
      device,
      options: {
        language: cfg.language,
        threads: cfg.threads ?? availableParallelism(),
        translate: false,
      },
    },
    (f) => onProgress("transcribing", f),
    signal,
  );

  // --- diarizing ---
  // explicit, defensive: transcribe's own status write is skipped on the zero-chunk
  // early-return path (an all-silence recording), so this is not always redundant
  setStatus(db, id, "diarizing");
  const embeddingSpec = cfg.embeddingModel
    ? (findEmbedding(cfg.embeddingModel) ?? raise(cfg.embeddingModel))
    : defaultEmbedding();
  const segmentation = await fetchModel(ctx, SEGMENTATION, cfg.downloadModels, signal);
  const embedding = await fetchModel(ctx, embeddingSpec, cfg.downloadModels, signal);

  // diarize's persist() writes status = 'done' in the same transaction as the merge
  await diarize(
    db,
    {
      recordingId: id,
      pcm: mainPcm,
      micPcm,
      segmentation,
      embedding,
      vadModel,
      config: {
        threshold: cfg.diarizeThreshold ?? DEFAULT_THRESHOLD,
        speakers: cfg.diarizeSpeakers,
      },
    },
    (f) => onProgress("diarizing", f),
    signal,
  );
}

/** Small models (vad) or a caller that opted into downloads: fetch if missing. Otherwise a
 *  missing model is a hard error naming what to fetch. */
function fetchModel(
  ctx: JobCtx,
  spec: ModelSpec,
  download: boolean,
  signal?: AbortSignal,
): Promise<string> {
  const dir = ctx.modelsDir;
  return download || isPresent(spec, dir)
    ? ensure(spec, { dir, signal })
    : Promise.resolve(locate(spec, dir));
}

/**
 * The watch folder a path lives directly under (watches are non-recursive) gives its track
 * rule. Files reached other ways (backfill of an arbitrary folder) fall back to auto.
 */
function owningTrackRule(db: Db, path: string): TrackRule {
  const parent = dirname(path);
  const folder = folderByPath(db, parent);
  return folder ? parseRule(folder.track_rule) : AUTO;
}

function raise(name: string): never {
  throw err.modelMissing(name);
}

function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw err.cancelled();
}
