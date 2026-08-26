// The compute worker. Everything that loads a native model runs here, in a utilityProcess:
// whisper and sherpa both block for minutes and both can abort the process from inside C++,
// so neither may share main's event loop.
//
// Port of the compute half of crates/unottr-core/src/{transcribe,diarize}/mod.rs. The
// database half of those files lives in main/ingest/pipeline.ts — this process never opens
// sqlite. One job per process; main forks per job and kills it after.

import type {} from "electron"; // pulls the utilityProcess globals (process.parentPort)
import { readFileSync } from "node:fs";
import { PipelineError, err, type ErrorDetail } from "../main/errors";
import { decodeS16 } from "../main/media/pcm";
import { pack, range } from "./chunk";
import { defaultConfig, Diarizer } from "./diarize";
import { assign } from "./merge";
import * as mic from "./mic";
import type { DiarizeJob, EmbedJob, Reply, Request, TranscribeJob } from "./protocol";
import { detectSpeech } from "./vad";
import { Transcriber, shift } from "./whisper";

/** Diarization takes nearly all the wall clock; main's persistence is the remaining 3%. */
const DIARIZE_SHARE = 0.97;

const cancel = new AbortController();
let stage: "transcribe" | "diarize" = "transcribe";
let started = false;

process.parentPort.on("message", (e) => {
  const request = e.data as Request;
  if (request.type === "cancel") {
    cancel.abort();
    return;
  }
  // main forks per job, so a second one is a bug on that side, not something to queue
  if (started) return;
  started = true;
  void handle(request);
});

process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);

async function handle(request: Request & { type: "transcribe" | "diarize" | "embed" }): Promise<void> {
  try {
    if (request.type === "transcribe") {
      stage = "transcribe";
      await transcribe(request.job);
      send({ type: "transcribed" });
    } else if (request.type === "diarize") {
      stage = "diarize";
      send({ type: "diarized", ...(await diarize(request.job)) });
    } else {
      stage = "diarize";
      send({ type: "embedded", embeddings: embed(request.job) });
    }
  } catch (e) {
    send({ type: "failed", error: detail(e) });
  }
}

function embed(job: EmbedJob): Float32Array[] {
  check();
  const pcm = decodeS16(read(job.pcm));
  const diarizer = Diarizer.load(job.segmentation, job.embedding, defaultConfig());
  const count = job.turns.reduce((n, turn) => Math.max(n, turn.speaker + 1), 0);
  const embeddings: Float32Array[] = [];
  for (let speaker = 0; speaker < count; speaker++) {
    check();
    embeddings.push(diarizer.centroid(pcm, job.turns, speaker));
    send({ type: "progress", pct: (speaker + 1) / count });
  }
  return embeddings;
}

async function transcribe(job: TranscribeJob): Promise<void> {
  const pcm = read(job.pcm);
  const chunks = pack(await detectSpeech(pcm, job.vad_model));
  send({ type: "plan", chunks });

  // a resumed run whose plan came out shorter has nothing left to do
  const todo = chunks.slice(job.from);
  if (todo.length === 0) return;

  const transcriber = await Transcriber.load(job.model, job.device, job.options);
  try {
    for (const chunk of todo) {
      check();
      const { lo, hi } = range(chunk, pcm.length >> 1);
      const utterances = await transcriber.run(pcm.subarray(lo * 2, hi * 2), cancel.signal);
      // whisper times every chunk from zero; the db stores absolute times
      send({ type: "chunk", idx: chunk.idx, utterances: utterances.map((u) => shift(u, chunk.start_ms)) });
    }
  } finally {
    await transcriber.release();
  }
}

async function diarize(job: DiarizeJob) {
  check();
  const pcm = decodeS16(read(job.pcm));
  const diarizer = Diarizer.load(job.segmentation, job.embedding, job.config);
  const progress = (f: number) => send({ type: "progress", pct: f * DIARIZE_SHARE });

  let result: Awaited<ReturnType<Diarizer["run"]>>;
  let labels: string[];
  if (job.mic_pcm) {
    const micRaw = read(job.mic_pcm);
    const you = await mic.detect(micRaw, job.vad_model);
    const desktop = await diarizer.run(pcm, progress, cancel.signal);
    // the local user's centroid comes off their own track, never the mixed one
    const youEmbedding = diarizer.centroid(decodeS16(micRaw), you, mic.YOU);
    result = mic.combine(you, youEmbedding, desktop);
    labels = result.embeddings.map((_, i) => mic.label(i));
  } else {
    result = await diarizer.run(pcm, progress, cancel.signal);
    labels = result.embeddings.map((_, i) => `Speaker ${i + 1}`);
  }
  check();

  return { labels, embeddings: result.embeddings, assigned: assign(job.segments, result.turns) };
}

const send = (reply: Reply): void => process.parentPort.postMessage(reply);

function fatal(e: unknown): void {
  send({ type: "failed", error: detail(e) });
  process.exit(1);
}

const detail = (e: unknown): ErrorDetail => {
  if (e instanceof PipelineError) return e.detail;
  const message = e instanceof Error ? e.message : String(e);
  return stage === "diarize" ? err.diarize(message).detail : err.whisper(message).detail;
};

const check = (): void => {
  if (cancel.signal.aborted) throw err.cancelled();
};

function read(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (e) {
    throw err.io(path, e);
  }
}
