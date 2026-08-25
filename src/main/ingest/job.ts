// One recording, start to finish. Port of crates/unottr-core/src/ingest/pipeline.rs (the name
// `pipeline.ts` was already taken by the transcribe/diarize database driver this calls into).
//
// Always runs the full sequence regardless of which non-terminal status it entered at — see
// reconcile.ts for why that is simpler and just as correct as resuming at the failed stage.

import { availableParallelism } from "node:os";
import { dirname, join, parse } from "node:path";
import type { Status } from "../../shared/ipc";
import { DEFAULT_THRESHOLD } from "../../worker/cluster";
import type { Db } from "../db/client";
import {
  forceCpuOf,
  pathOf,
  setFingerprint,
  setProbeResult,
  setStatus,
  statusOf,
} from "../db/recordings";
import * as stageRates from "../db/stage-rates";
import * as terminology from "../db/terminology";
import { findByPath as folderByPath } from "../db/watch-folders";
import { err, isCancelled } from "../errors";
import { type FfmpegCli, extractPcm, extractThumbnails, probe } from "../media/ffmpeg";
import { mixPcm } from "../media/pcm";
import { PREVIEW_COUNT, previewPathFor, thumbPathFor } from "../media/thumbs";
import type { Probe } from "../media/types";
import { AUTO, type TrackRule, parseRule, select } from "../media/track";
import {
  type ModelSpec,
  SEGMENTATION,
  VAD,
  defaultEmbedding,
  findEmbedding,
  findWhisper,
  whisperPreference,
} from "../models/catalog";
import { resolve as resolveDevice } from "../models/device";
import { ensure, isPresent, locate } from "../models/download";
import type { PipelineConfig } from "./config";
import { Eta, type Rates, type Timed, prior, rateKey } from "./eta";
import { compute } from "./fingerprint";
import { diarize, transcribe } from "./pipeline";
import {
  type SourceVersion,
  assertSourceVersion,
  cacheMatchesSource,
  discardCachedPcm,
  markCacheSource,
  sourceVersion,
} from "./source";

export interface JobCtx {
  db: Db;
  cli: FfmpegCli;
  cacheDir: string;
  thumbsDir: string;
  modelsDir: string;
  cfg: PipelineConfig;
}

/** `etaMs` is the whole job's remaining wall time, null while it cannot be estimated. */
export type OnProgress = (stage: Status, pct: number, etaMs: number | null) => void;

/** `{stem}.t{n}.pcm` in the cache dir — the name reconcile.ts's stale sweep parses back. */
export const pcmPathFor = (cacheDir: string, source: string, audioIndex: number): string =>
  join(cacheDir, `${parse(source).name}.t${audioIndex}.pcm`);

export async function processRecording(
  ctx: JobCtx,
  id: number,
  onProgress: OnProgress,
  signal?: AbortSignal,
): Promise<void> {
  const { db, cli, thumbsDir, cfg } = ctx;
  check(signal);
  const path = pathOf(db, id);
  if (path === null) throw err.probe("", `recording ${id} vanished from the database`);
  const source = sourceVersion(path);

  // --- probing ---
  setStatus(db, id, "probing");
  onProgress("probing", 0, null);
  const probed = await probe(cli, path);
  assertSourceVersion(path, source);
  setProbeResult(db, id, probed.container, probed.duration_ms);

  // a prior run may have gpu-oom'd (the queue's fallback persists this) — read it back so
  // the override survives a restart, not just the one automatic in-process retry
  const devicePref = forceCpuOf(db, id) ? "cpu" : cfg.device;
  const device = resolveDevice(devicePref);
  const whisperSpec = cfg.whisperModel
    ? (findWhisper(cfg.whisperModel) ?? raise(cfg.whisperModel))
    : autoWhisper(ctx.modelsDir, device === "gpu");
  const embeddingSpec = cfg.embeddingModel
    ? (findEmbedding(cfg.embeddingModel) ?? raise(cfg.embeddingModel))
    : defaultEmbedding();

  // resolved before anything slow starts, so the very first tick can already say how long
  const keys: Record<Timed, string> = {
    extracting: rateKey("extracting", device, "ffmpeg"),
    transcribing: rateKey("transcribing", device, whisperSpec.name),
    // sherpa is cpu-only, so this rate does not vary with what asr ran on
    diarizing: rateKey("diarizing", "cpu", embeddingSpec.name),
  };
  const rates = Object.fromEntries(
    Object.entries(keys).map(([stage, key]) => [stage, stageRates.rate(db, key, prior(key))]),
  ) as Rates;
  const eta = new Eta({ durationMs: probed.duration_ms, rates });
  const report = (stage: Status, pct: number): void => onProgress(stage, pct, eta.tick(stage, pct));

  report("probing", 1);

  if (probed.has_video && probed.duration_ms) {
    try {
      await extractThumbnails(cli, path, {
        durationMs: probed.duration_ms,
        thumb: thumbPathFor(thumbsDir, id),
        previews: Array.from({ length: PREVIEW_COUNT }, (_, i) => previewPathFor(thumbsDir, id, i)),
        signal,
      });
    } catch (e) {
      // cancellation must still abort the job; any other failure just means no thumbnails
      if (isCancelled(e)) throw e;
      console.warn(`thumbnail generation failed for recording ${id}: ${String(e)}`);
    }
  }

  // --- extracting ---
  setStatus(db, id, "extracting");
  report("extracting", 0);
  const { mainPcm, micPcm } = await prepareAudio(
    ctx,
    path,
    source,
    probed,
    (f) => report("extracting", f),
    signal,
  );
  report("extracting", 1);

  // --- transcribing (checkpointed inside transcribe) ---
  const whisperModel = await fetchModel(ctx, whisperSpec, cfg.downloadModels, signal);
  const vadModel = await fetchModel(ctx, VAD, true, signal);

  report("transcribing", 0);
  const startedTranscribe = Date.now();
  const transcribed = await transcribe(
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
    (f) => report("transcribing", f),
    signal,
  );
  assertSourceVersion(path, source);
  // a resumed run's wall covers only the chunks it actually ran, so it is not a measurement
  if (transcribed.resumedFrom === 0) {
    stageRates.record(db, keys.transcribing, Date.now() - startedTranscribe, probed.duration_ms ?? 0);
  }

  // --- diarizing ---
  // explicit, defensive: transcribe's own status write is skipped on the zero-chunk
  // early-return path (an all-silence recording), so this is not always redundant
  setStatus(db, id, "diarizing");
  // always fetched, like VAD: every job diarizes, so `downloadModels` would only ever be the
  // difference between fetching 34 MB and failing the job over it
  const segmentation = await fetchModel(ctx, SEGMENTATION, true, signal);
  const embedding = await fetchModel(ctx, embeddingSpec, true, signal);

  report("diarizing", 0);
  const startedDiarize = Date.now();
  let finalFingerprint: Awaited<ReturnType<typeof compute>> | null = null;
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
      validate: async () => {
        assertSourceVersion(path, source);
        finalFingerprint = await compute(path);
        assertSourceVersion(path, source);
      },
    },
    (f) => report("diarizing", f),
    signal,
  );
  if (finalFingerprint) setFingerprint(db, id, finalFingerprint);
  terminology.applyToRecording(db, id);
  stageRates.record(db, keys.diarizing, Date.now() - startedDiarize, probed.duration_ms ?? 0);
}

/** The tracks the compute stages read. Cached pcm is reused as-is, which is what makes a
 *  re-diarize cheap: nothing is decoded twice. */
interface Audio {
  mainPcm: string;
  micPcm: string | null;
}

async function prepareAudio(
  ctx: JobCtx,
  path: string,
  source: SourceVersion,
  probed: Probe,
  onFraction: (f: number) => void,
  signal?: AbortSignal,
): Promise<Audio> {
  const { db, cli, cacheDir } = ctx;
  const choice = select(probed, owningTrackRule(db, path));

  const extractTrack = async (audioIndex: number): Promise<string> => {
    const out = pcmPathFor(cacheDir, path, audioIndex);
    if (cacheMatchesSource(out, source)) return out;
    discardCachedPcm(out);
    try {
      await extractPcm(cli, path, { audioIndex, out, onProgress: onFraction, signal });
      assertSourceVersion(path, source);
      markCacheSource(out, source);
    } catch (e) {
      discardCachedPcm(out);
      throw e;
    }
    return out;
  };

  if (choice.selection.kind === "blind") {
    return { mainPcm: await extractTrack(choice.selection.stream), micPcm: null };
  }
  const mic = await extractTrack(choice.selection.mic);
  const desktop = await extractTrack(choice.selection.desktop);
  const mix = join(cacheDir, `${parse(path).name}.mix.pcm`);
  if (!cacheMatchesSource(mix, source)) {
    discardCachedPcm(mix);
    try {
      mixPcm([mic, desktop], mix);
      assertSourceVersion(path, source);
      markCacheSource(mix, source);
    } catch (e) {
      discardCachedPcm(mix);
      throw e;
    }
  }
  return { mainPcm: mix, micPcm: mic };
}

/**
 * Re-cluster a finished recording's voices at a count the user supplied (decision #50). Only
 * the speaker rows and `segments.speaker_id` change — the text is never touched, so fts stays
 * valid. Names come back by voiceprint, not by label: with a different `speakers` the old
 * "Speaker 2" is not the new one, so carrying names across by name would be a lie.
 */
export async function rediarizeRecording(
  ctx: JobCtx,
  id: number,
  speakers: number | null,
  onProgress: OnProgress,
  signal?: AbortSignal,
): Promise<void> {
  const { db, cli, cfg } = ctx;
  check(signal);
  const path = pathOf(db, id);
  if (path === null) throw err.probe("", `recording ${id} vanished from the database`);
  const source = sourceVersion(path);
  // the transcript is already there; a failure has to put the row back exactly as it was
  const was = statusOf(db, id) ?? "done";

  setStatus(db, id, "diarizing");
  try {
    const probed = await probe(cli, path);
    assertSourceVersion(path, source);
    const { mainPcm, micPcm } = await prepareAudio(ctx, path, source, probed, () => {}, signal);

    const embeddingSpec = cfg.embeddingModel
      ? (findEmbedding(cfg.embeddingModel) ?? raise(cfg.embeddingModel))
      : defaultEmbedding();
    const vadModel = await fetchModel(ctx, VAD, true, signal);
    const segmentation = await fetchModel(ctx, SEGMENTATION, true, signal);
    const embedding = await fetchModel(ctx, embeddingSpec, true, signal);

    const key = rateKey("diarizing", "cpu", embeddingSpec.name);
    const eta = new Eta({
      durationMs: probed.duration_ms,
      // only the one stage runs, so the others cost nothing to be ahead of
      rates: { extracting: 0, transcribing: 0, diarizing: stageRates.rate(db, key, prior(key)) },
    });
    onProgress("diarizing", 0, eta.tick("diarizing", 0));

    const started = Date.now();
    // persist() writes the new cast, bumps speakers_version and sets status = 'done'
    await diarize(
      db,
      {
        recordingId: id,
        pcm: mainPcm,
        micPcm,
        segmentation,
        embedding,
        vadModel,
        config: { threshold: cfg.diarizeThreshold ?? DEFAULT_THRESHOLD, speakers },
        keepNames: false,
      },
      (f) => onProgress("diarizing", f, eta.tick("diarizing", f)),
      signal,
    );
    terminology.applyToRecording(db, id);
    stageRates.record(db, key, Date.now() - started, probed.duration_ms ?? 0);
  } catch (e) {
    setStatus(db, id, was);
    throw e;
  }
}

/**
 * `auto` resolves by device, but the tier onboarding actually downloaded wins over one that
 * is merely ideal — a gpu box asking for turbo it never fetched fails the job for nothing.
 */
function autoWhisper(dir: string, gpu: boolean): ModelSpec {
  const order = whisperPreference(gpu);
  // nothing on disk: keep the ideal one so the error names the model to go download
  return order.find((m) => isPresent(m, dir)) ?? order[0];
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
