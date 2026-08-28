// One recording, start to finish. Port of crates/unottr-core/src/ingest/pipeline.rs (the name
// `pipeline.ts` was already taken by the transcribe/diarize database driver this calls into).
//
// New and failed recordings run the full sequence. An explicit retranscription uses the same
// checkpoints and source checks but stops before the optional speaker pass.

import { availableParallelism } from "node:os";
import { dirname, join, parse } from "node:path";
import { eq } from "drizzle-orm";
import type { JobPhase, ModelDownloadPhase, Status } from "../../shared/ipc";
import { DEFAULT_THRESHOLD } from "../../worker/cluster";
import type { Db } from "../db/client";
import {
  forceCpuOf,
  pathOf,
  setFingerprint,
  setProbeResult,
  setStatus,
  statusOf,
  whisperFallbackOf,
} from "../db/recordings";
import * as stageRates from "../db/stage-rates";
import { recordings } from "../db/schema";
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
import { gpus, resolve as resolveDevice } from "../models/device";
import { ensure, isPresent, locate } from "../models/download";
import {
  SORTFORMER,
  ensureSortformer,
  isSortformerPresent,
  sortformerRuntime,
} from "../models/sortformer";
import { isAppleSilicon } from "../platform";
import type { PipelineConfig } from "./config";
import { Eta, type Rates, type Timed, prior, rateKey } from "./eta";
import { compute } from "./fingerprint";
import { completeTranscriptionOnly, diarize, diarizeSortformer, transcribe } from "./pipeline";
import {
  SourceChangedError,
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
export type OnProgress = (
  stage: Status,
  pct: number,
  etaMs: number | null,
  phase: JobPhase,
) => void;

/** `{stem}.t{n}.pcm` in the cache dir — the name reconcile.ts's stale sweep parses back. */
export const pcmPathFor = (cacheDir: string, source: string, audioIndex: number): string =>
  join(cacheDir, `${parse(source).name}.t${audioIndex}.pcm`);

export async function processRecording(
  ctx: JobCtx,
  id: number,
  onProgress: OnProgress,
  signal?: AbortSignal,
  options: { diarize?: boolean } = {},
): Promise<void> {
  const { db, cli, thumbsDir, cfg } = ctx;
  check(signal);
  const path = pathOf(db, id);
  if (path === null) throw err.probe("", `recording ${id} vanished from the database`);
  const source = sourceVersion(path);

  // --- probing ---
  setStatus(db, id, "probing");
  onProgress("probing", 0, null, null);
  const probed = await probe(cli, path);
  assertSourceVersion(path, source);
  setProbeResult(db, id, probed.container, probed.duration_ms);

  // persisted before retry -> restart cannot restore the OOM plan
  const appleSilicon = isAppleSilicon();
  const whisperFallback = whisperFallbackOf(db, id);
  const useSmallMetal = whisperFallback === "small-metal" && appleSilicon;
  const devicePref = useSmallMetal ? "gpu" : forceCpuOf(db, id) ? "cpu" : cfg.device;
  const device = resolveDevice(devicePref);
  const whisperSpec = useSmallMetal
    ? (findWhisper("small") ?? raise("small"))
    : cfg.whisperModel
      ? (findWhisper(cfg.whisperModel) ?? raise(cfg.whisperModel))
      : autoWhisper(ctx.modelsDir, device === "gpu");
  const backend = device === "cpu" ? "cpu" : appleSilicon ? "metal" : "vulkan";
  console.info(
    `recording ${id} whisper requested=${cfg.whisperModel ?? "auto"} actual=${whisperSpec.name} backend=${backend} fallback=${whisperFallback ?? "none"}`,
  );
  const embeddingSpec = cfg.embeddingModel
    ? (findEmbedding(cfg.embeddingModel) ?? raise(cfg.embeddingModel))
    : defaultEmbedding();

  // resolved before anything slow starts, so the very first tick can already say how long
  const plannedFastDiarization = cfg.diarizeSpeakers === null && fastDiarizationAvailable();
  const keys: Record<Timed, string> = {
    extracting: rateKey("extracting", device, "ffmpeg"),
    transcribing: rateKey("transcribing", device, whisperSpec.name),
    diarizing: plannedFastDiarization
      ? rateKey("diarizing", "gpu", SORTFORMER.name)
      : rateKey("diarizing", "cpu", embeddingSpec.name),
  };
  const rates = Object.fromEntries(
    Object.entries(keys).map(([stage, key]) => [stage, stageRates.rate(db, key, prior(key))]),
  ) as Rates;
  if (options.diarize === false) rates.diarizing = 0;
  const eta = new Eta({ durationMs: probed.duration_ms, rates });
  const report = (stage: Status, pct: number, phase: JobPhase = null): void =>
    onProgress(stage, pct, eta.tick(stage, pct), phase);
  const announce = (stage: Status, pct: number, phase: Exclude<JobPhase, null>): void => {
    setStatus(db, id, stage, phase);
    report(stage, pct, phase);
  };

  report("probing", 1);

  if (probed.has_video && probed.duration_ms) {
    try {
      announce("probing", 0, "generating_previews");
      await extractThumbnails(cli, path, {
        durationMs: probed.duration_ms,
        thumb: thumbPathFor(thumbsDir, id),
        previews: Array.from({ length: PREVIEW_COUNT }, (_, i) => previewPathFor(thumbsDir, id, i)),
        signal,
        onProgress: (pct) => report("probing", pct, "generating_previews"),
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
    (phase, pct) => announce("extracting", pct, phase),
    signal,
  );
  if (plannedFastDiarization && micPcm !== null) {
    const cpuKey = rateKey("diarizing", "cpu", embeddingSpec.name);
    rates.diarizing = stageRates.rate(db, cpuKey, prior(cpuKey));
  }
  report("extracting", 1);

  // --- transcribing (checkpointed inside transcribe) ---
  // Persist the transition before model lookup or worker startup. The renderer can miss the
  // in-memory progress tick when it mounts during startup, and a worker can fail before its
  // first chunk; in both cases leaving the row as "extracting" is both stale and misleading.
  setStatus(db, id, "transcribing", "detecting_speech");
  const transcribeModelActivity = modelActivity(
    (phase, pct) => announce("transcribing", pct, phase),
  );
  const whisperModel = await fetchModel(
    ctx,
    whisperSpec,
    cfg.downloadModels,
    signal,
    transcribeModelActivity,
  );
  const vadModel = await fetchModel(ctx, VAD, true, signal, transcribeModelActivity);

  report("transcribing", 0, "detecting_speech");
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
  const transcriptionDurationMs = Date.now() - startedTranscribe;
  assertSourceVersion(path, source);
  db.update(recordings)
    .set({ transcriptionDurationMs })
    .where(eq(recordings.id, id))
    .run();
  // a resumed run's wall covers only the chunks it actually ran, so it is not a measurement
  if (transcribed.resumedFrom === 0) {
    stageRates.record(db, keys.transcribing, transcriptionDurationMs, probed.duration_ms ?? 0);
  }

  if (options.diarize === false) {
    const finalFingerprint = await compute(path);
    assertSourceVersion(path, source);
    setFingerprint(db, id, finalFingerprint);
    terminology.applyToRecording(db, id);
    completeTranscriptionOnly(db, id);
    return;
  }

  // --- diarizing ---
  // explicit, defensive: transcribe's own status write is skipped on the zero-chunk
  // early-return path (an all-silence recording), so this is not always redundant
  setStatus(db, id, "diarizing");
  // always fetched, like VAD: every job diarizes, so `downloadModels` would only ever be the
  // difference between fetching 34 MB and failing the job over it
  const diarizeModelActivity = modelActivity(
    (phase, pct) => announce("diarizing", pct, phase),
  );
  const segmentation = await fetchModel(ctx, SEGMENTATION, true, signal, diarizeModelActivity);
  const embedding = await fetchModel(ctx, embeddingSpec, true, signal, diarizeModelActivity);

  report("diarizing", 0);
  const startedDiarize = Date.now();
  let finalFingerprint: Awaited<ReturnType<typeof compute>> | null = null;
  // diarize's persist() writes status = 'done' in the same transaction as the merge
  const actualDiarizeKey = await identifySpeakers(
    ctx,
    {
      recordingId: id,
      mainPcm,
      micPcm,
      segmentation,
      embedding,
      embeddingName: embeddingSpec.name,
      vadModel,
      speakers: cfg.diarizeSpeakers,
      onRateKey: (key) => {
        rates.diarizing = stageRates.rate(db, key, prior(key));
      },
      validate: async () => {
        assertSourceVersion(path, source);
        finalFingerprint = await compute(path);
        assertSourceVersion(path, source);
      },
      onPhase: (phase, pct) => announce("diarizing", pct, phase),
      onFinishing: () => announce("merging", 0, "finishing"),
    },
    (f) => report("diarizing", f),
    signal,
  );
  if (finalFingerprint) setFingerprint(db, id, finalFingerprint);
  terminology.applyToRecording(db, id);
  const diarizationDurationMs = Date.now() - startedDiarize;
  db.update(recordings)
    .set({ diarizationDurationMs })
    .where(eq(recordings.id, id))
    .run();
  stageRates.record(db, actualDiarizeKey, diarizationDurationMs, probed.duration_ms ?? 0);
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
  onPhase: ((phase: "mixing_tracks", pct: number) => void) | undefined,
  signal?: AbortSignal,
): Promise<Audio> {
  const { db, cli, cacheDir } = ctx;
  const choice = select(probed, owningTrackRule(db, path));

  const extractTrack = async (
    audioIndex: number,
    progress: (pct: number) => void,
  ): Promise<string> => {
    const out = pcmPathFor(cacheDir, path, audioIndex);
    if (cacheMatchesSource(out, source)) return out;
    discardCachedPcm(out);
    try {
      await extractPcm(cli, path, { audioIndex, out, onProgress: progress, signal });
      assertSourceVersion(path, source);
      markCacheSource(out, source);
    } catch (e) {
      discardCachedPcm(out);
      throw e;
    }
    return out;
  };

  if (choice.selection.kind === "blind") {
    return { mainPcm: await extractTrack(choice.selection.stream, onFraction), micPcm: null };
  }
  const mic = await extractTrack(choice.selection.mic, (pct) => onFraction(pct * 0.45));
  const desktop = await extractTrack(
    choice.selection.desktop,
    (pct) => onFraction(0.45 + pct * 0.45),
  );
  const mix = join(cacheDir, `${parse(path).name}.mix.pcm`);
  if (!cacheMatchesSource(mix, source)) {
    discardCachedPcm(mix);
    try {
      onPhase?.("mixing_tracks", 0.9);
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
 * Re-cluster a finished recording's voices automatically or at a count the user supplied.
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

  setStatus(db, id, "diarizing", "preparing_audio");
  try {
    onProgress("diarizing", 0, null, "preparing_audio");
    const probed = await probe(cli, path);
    assertSourceVersion(path, source);
    const { mainPcm, micPcm } = await prepareAudio(
      ctx,
      path,
      source,
      probed,
      (pct) => onProgress("diarizing", pct, null, "preparing_audio"),
      (phase, pct) => {
        setStatus(db, id, "diarizing", phase);
        onProgress("diarizing", pct, null, phase);
      },
      signal,
    );

    const embeddingSpec = cfg.embeddingModel
      ? (findEmbedding(cfg.embeddingModel) ?? raise(cfg.embeddingModel))
      : defaultEmbedding();
    const announceModel = modelActivity((phase, pct) => {
      setStatus(db, id, "diarizing", phase);
      onProgress("diarizing", pct, null, phase);
    });
    const vadModel = await fetchModel(ctx, VAD, true, signal, announceModel);
    const segmentation = await fetchModel(ctx, SEGMENTATION, true, signal, announceModel);
    const embedding = await fetchModel(ctx, embeddingSpec, true, signal, announceModel);

    const plannedFast = speakers === null && micPcm === null && fastDiarizationAvailable();
    const key = plannedFast
      ? rateKey("diarizing", "gpu", SORTFORMER.name)
      : rateKey("diarizing", "cpu", embeddingSpec.name);
    const rates: Rates = {
      extracting: 0,
      transcribing: 0,
      diarizing: stageRates.rate(db, key, prior(key)),
    };
    const eta = new Eta({
      durationMs: probed.duration_ms,
      // only the one stage runs, so the others cost nothing to be ahead of
      rates,
    });
    onProgress("diarizing", 0, eta.tick("diarizing", 0), null);

    const started = Date.now();
    // persist() writes the new cast, bumps speakers_version and sets status = 'done'
    const actualKey = await identifySpeakers(
      ctx,
      {
        recordingId: id,
        mainPcm,
        micPcm,
        segmentation,
        embedding,
        embeddingName: embeddingSpec.name,
        vadModel,
        speakers,
        keepNames: false,
        onRateKey: (actual) => {
          rates.diarizing = stageRates.rate(db, actual, prior(actual));
        },
        onPhase: (phase, pct) => {
          setStatus(db, id, "diarizing", phase);
          onProgress("diarizing", pct, eta.tick("diarizing", pct), phase);
        },
        onFinishing: () => {
          setStatus(db, id, "merging", "finishing");
          onProgress("merging", 0, null, "finishing");
        },
      },
      (f) => onProgress("diarizing", f, eta.tick("diarizing", f), null),
      signal,
    );
    terminology.applyToRecording(db, id);
    const diarizationDurationMs = Date.now() - started;
    db.update(recordings)
      .set({ diarizationDurationMs })
      .where(eq(recordings.id, id))
      .run();
    stageRates.record(db, actualKey, diarizationDurationMs, probed.duration_ms ?? 0);
  } catch (e) {
    setStatus(db, id, was);
    throw e;
  }
}

interface SpeakerJob {
  recordingId: number;
  mainPcm: string;
  micPcm: string | null;
  segmentation: string;
  embedding: string;
  embeddingName: string;
  vadModel: string;
  speakers: number | null;
  keepNames?: boolean;
  onRateKey?: (key: string) => void;
  onPhase?: (phase: Exclude<JobPhase, null | "queued">, pct: number) => void;
  onFinishing?: () => void;
  validate?: () => void | Promise<void>;
}

async function identifySpeakers(
  ctx: JobCtx,
  job: SpeakerJob,
  progress: (pct: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const runtime = job.speakers === null && job.micPcm === null ? sortformerRuntime() : null;
  let fellBack = false;
  if (runtime && gpus().length > 0) {
    const gpuKey = rateKey("diarizing", "gpu", SORTFORMER.name);
    job.onRateKey?.(gpuKey);
    try {
      let phase: Exclude<JobPhase, null | "queued"> = "connecting_model";
      const modelMissing = !isSortformerPresent(ctx.modelsDir);
      const model = await ensureSortformer({
        dir: ctx.modelsDir,
        signal,
        onPhase: modelMissing ? (next) => {
          if (next === "done") return;
          phase = jobPhase(next);
          job.onPhase?.(phase, 0);
        } : undefined,
        onProgress: modelMissing ? (pct) => job.onPhase?.(phase, pct) : undefined,
      });
      await diarizeSortformer(
        ctx.db,
        {
          recordingId: job.recordingId,
          pcm: job.mainPcm,
          segmentation: job.segmentation,
          embedding: job.embedding,
          runtime,
          model,
          threads: ctx.cfg.threads ?? availableParallelism(),
          keepNames: job.keepNames,
          validate: job.validate,
          onPersist: job.onFinishing,
        },
        progress,
        signal,
      );
      return gpuKey;
    } catch (e) {
      if (isCancelled(e) || e instanceof SourceChangedError) throw e;
      console.warn(`Vulkan diarization failed; retrying on CPU: ${String(e)}`);
      fellBack = true;
    }
  }

  const cpuKey = rateKey("diarizing", "cpu", job.embeddingName);
  job.onRateKey?.(cpuKey);
  if (fellBack) {
    progress(0);
    job.onPhase?.("retrying_on_cpu", 0);
  }
  if (job.micPcm && job.speakers === null) job.onPhase?.("detecting_mic_speech", 0);
  await diarize(
    ctx.db,
    {
      recordingId: job.recordingId,
      pcm: job.mainPcm,
      // An exact count means the whole meeting. The separate-mic path adds "You" after
      // clustering and would therefore return one more speaker than the user requested.
      micPcm: job.speakers === null ? job.micPcm : null,
      segmentation: job.segmentation,
      embedding: job.embedding,
      vadModel: job.vadModel,
      config: {
        threshold: ctx.cfg.diarizeThreshold ?? DEFAULT_THRESHOLD,
        speakers: job.speakers,
      },
      keepNames: job.keepNames,
      validate: job.validate,
      engine: "sherpa-cpu",
      speakerLimitHit: false,
      onPersist: job.onFinishing,
    },
    progress,
    signal,
  );
  return cpuKey;
}

const fastDiarizationAvailable = (): boolean => sortformerRuntime() !== null && gpus().length > 0;

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
  onActivity?: (phase: Exclude<JobPhase, null | "queued">, pct: number) => void,
): Promise<string> {
  const dir = ctx.modelsDir;
  if (!download && !isPresent(spec, dir)) return Promise.resolve(locate(spec, dir));
  if (isPresent(spec, dir)) return ensure(spec, { dir, signal });

  let phase: Exclude<JobPhase, null | "queued"> = "connecting_model";
  return ensure(spec, {
    dir,
    signal,
    onPhase: (next) => {
      if (next === "done") return;
      phase = jobPhase(next);
      onActivity?.(phase, 0);
    },
    onProgress: (pct) => onActivity?.(phase, pct),
  });
}

const jobPhase = (phase: ModelDownloadPhase): Exclude<JobPhase, null | "queued"> =>
  phase === "connecting"
    ? "connecting_model"
    : phase === "downloading" ? "downloading_model" : "verifying_model";

const modelActivity = (
  report: (phase: Exclude<JobPhase, null | "queued">, pct: number) => void,
) => report;

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
