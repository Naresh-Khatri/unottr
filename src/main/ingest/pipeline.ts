// The database half of crates/unottr-core/src/{transcribe,diarize}/mod.rs. The compute half
// runs in src/worker; this drives it and owns every write.
//
// Splitting the two moved one thing: the rust checkpointed inline after each chunk, here the
// worker sends the chunk and main writes it. The guarantee is unchanged — `last_chunk_idx` is
// only ever advanced in the same transaction that inserts that chunk's segments — and `rewind`
// now runs before dispatch, so the worker is told which chunk to start at instead of asking.

import { join } from "node:path";
import { and, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { utilityProcess } from "electron";
import type { Resolved } from "../../shared/ipc";
import type { Chunk } from "../../worker/chunk";
import type { Config } from "../../worker/diarize";
import { type Assigned, type Segment, isSplit } from "../../worker/merge";
import type { DiarizeJob, Reply, Request, TranscribeJob } from "../../worker/protocol";
import type { Options, Utterance, Word } from "../../worker/whisper";
import type { Db } from "../db/client";
import { lastChunkIdx, now } from "../db/recordings";
import { recordings, segments, speakers } from "../db/schema";
import { PipelineError, err } from "../errors";

export interface TranscribeSpec {
  recordingId: number;
  pcm: string;
  model: string;
  vadModel: string;
  device: Resolved;
  options: Options;
}

export interface TranscribeReport {
  device: Resolved;
  chunks: number;
  /** Chunks already checkpointed when we started; 0 on a fresh run. */
  resumedFrom: number;
  segments: number;
  speechMs: number;
}

export interface DiarizeSpec {
  recordingId: number;
  /** The track to cluster. With `micPcm` set this is the desktop track. */
  pcm: string;
  micPcm: string | null;
  segmentation: string;
  embedding: string;
  vadModel: string;
  config: Config;
}

export interface DiarizeReport {
  speakers: number;
  segments: number;
  /** Segments a speaker change ran through, so they were cut in two. */
  split: number;
  /** Segments no turn overlapped. Rendered without a name rather than guessed at. */
  unattributed: number;
  micTrack: boolean;
}

export type Progress = (fraction: number) => void;

/** Drizzle's transaction handle — same query surface as {@link Db}, different class. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Transcribe one recording, checkpointing after every chunk. Safe to call again after a
 * crash: the chunk plan is a pure function of the pcm, so the boundaries come out identical
 * and `last_chunk_idx` still means what it meant.
 */
export async function transcribe(
  db: Db,
  spec: TranscribeSpec,
  progress: Progress,
  signal?: AbortSignal,
): Promise<TranscribeReport> {
  const from = rewind(db, spec.recordingId);
  let chunks: Chunk[] = [];

  const job: TranscribeJob = {
    pcm: spec.pcm,
    model: spec.model,
    vad_model: spec.vadModel,
    device: spec.device,
    options: spec.options,
    from,
  };

  await dispatch<true>({ type: "transcribe", job }, signal, (reply) => {
    switch (reply.type) {
      case "plan":
        chunks = reply.chunks;
        return undefined;
      case "chunk":
        checkpoint(db, spec.recordingId, reply.idx, reply.utterances);
        progress(clamp01((reply.idx + 1) / chunks.length));
        return undefined;
      case "transcribed":
        return true;
      default:
        return undefined;
    }
  });

  const report: TranscribeReport = {
    device: spec.device,
    chunks: chunks.length,
    resumedFrom: from,
    segments: countSegments(db, spec.recordingId),
    speechMs: chunks.reduce((ms, c) => ms + (c.end_ms - c.start_ms), 0),
  };
  db.update(recordings)
    .set({ status: "diarizing", stageDetail: null, error: null, updatedAt: now() })
    .where(eq(recordings.id, spec.recordingId))
    .run();
  return report;
}

/** Cluster the recording's voices and attach them to its transcript rows. */
export async function diarize(
  db: Db,
  spec: DiarizeSpec,
  progress: Progress,
  signal?: AbortSignal,
): Promise<DiarizeReport> {
  const loaded = loadSegments(db, spec.recordingId);

  const job: DiarizeJob = {
    pcm: spec.pcm,
    mic_pcm: spec.micPcm,
    segmentation: spec.segmentation,
    embedding: spec.embedding,
    vad_model: spec.vadModel,
    config: spec.config,
    segments: loaded.map((l) => l.seg),
  };

  const out = await dispatch<Extract<Reply, { type: "diarized" }>>(
    { type: "diarize", job },
    signal,
    (reply) => {
      if (reply.type === "progress") progress(clamp01(reply.pct));
      return reply.type === "diarized" ? reply : undefined;
    },
  );

  const counts = persist(db, spec.recordingId, out.labels, out.embeddings, loaded, out.assigned);
  progress(1);

  return {
    speakers: out.embeddings.length,
    segments: loaded.length,
    split: counts.split,
    unattributed: counts.unattributed,
    micTrack: spec.micPcm !== null,
  };
}

// ---------------------------------------------------------------------------- the worker

/**
 * One utilityProcess per job. `handle` returns the job's result to finish, undefined to keep
 * listening; anything it throws fails the job. The child is killed either way — whisper and
 * sherpa both hold vram, and a fresh process is the only reliable way to get it back.
 */
function dispatch<T>(
  request: Request,
  signal: AbortSignal | undefined,
  handle: (reply: Reply) => T | undefined,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const child = utilityProcess.fork(join(__dirname, "worker.cjs"), [], {
      serviceName: "unottr-compute",
    });

    let settled = false;
    const finish = (act: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      child.kill();
      act();
    };
    const onAbort = () => child.postMessage({ type: "cancel" } satisfies Request);
    signal?.addEventListener("abort", onAbort);

    child.on("message", (reply: Reply) => {
      if (reply.type === "failed") {
        finish(() => reject(new PipelineError(reply.error)));
        return;
      }
      try {
        const out = handle(reply);
        if (out !== undefined) finish(() => resolve(out));
      } catch (e) {
        finish(() => reject(e));
      }
    });

    // ggml aborts from inside c++ on a bad allocation, so a dead worker is a normal failure
    // mode and not one it ever gets to report
    child.on("exit", (code) => {
      finish(() => reject(crashed(request, code)));
    });

    child.once("spawn", () => child.postMessage(request));
  });
}

const crashed = (request: Request, code: number): PipelineError => {
  const message = `compute worker exited (${code})`;
  return request.type === "diarize" ? err.diarize(message) : err.whisper(message);
};

// ---------------------------------------------------------------------------- transcribe

/**
 * Drop anything past the checkpoint and report where to restart. Guards the window between
 * inserting a chunk's segments and recording that we did.
 */
function rewind(db: Db, recordingId: number): number {
  const last = lastChunkIdx(db, recordingId);
  if (last === null) {
    // no checkpoint = start over, and any orphan segments are from a run that never wrote one
    db.delete(segments).where(eq(segments.recordingId, recordingId)).run();
    return 0;
  }
  db.delete(segments)
    .where(and(eq(segments.recordingId, recordingId), gt(segments.chunkIdx, last)))
    .run();
  return Math.max(0, last + 1);
}

function checkpoint(db: Db, recordingId: number, idx: number, utterances: Utterance[]): void {
  db.transaction((tx) => {
    if (utterances.length > 0) {
      tx.insert(segments)
        .values(
          utterances.map((u) => ({
            recordingId,
            chunkIdx: idx,
            startMs: u.start_ms,
            endMs: u.end_ms,
            text: u.text,
            words: JSON.stringify(u.words),
          })),
        )
        .run();
    }
    tx.update(recordings)
      .set({
        lastChunkIdx: idx,
        status: "transcribing",
        stageDetail: `chunk ${idx}`,
        updatedAt: now(),
      })
      .where(eq(recordings.id, recordingId))
      .run();
  });
}

const countSegments = (db: Db, recordingId: number): number =>
  db
    .select({ n: sql<number>`count(*)` })
    .from(segments)
    .where(eq(segments.recordingId, recordingId))
    .get()?.n ?? 0;

// ---------------------------------------------------------------------------- diarize

/**
 * One logical transcript segment plus the rows it currently occupies. A previous diarization
 * may have left it as several rows; the merge algorithm must see it whole again or every
 * re-run splits the pieces further.
 */
interface Loaded {
  seg: Segment;
  rows: number[];
}

function loadSegments(db: Db, recordingId: number): Loaded[] {
  const rows = db
    .select({
      key: sql<number>`coalesce(${segments.splitOf}, ${segments.id})`,
      id: segments.id,
      chunkIdx: segments.chunkIdx,
      startMs: segments.startMs,
      endMs: segments.endMs,
      text: segments.text,
      words: segments.words,
    })
    .from(segments)
    .where(eq(segments.recordingId, recordingId))
    .orderBy(segments.startMs, segments.id)
    .all();

  const byKey = new Map<number, Loaded>();
  for (const row of rows) {
    const words = parseWords(row.words);
    const found = byKey.get(row.key);
    if (found) {
      found.seg.start_ms = Math.min(found.seg.start_ms, Math.max(0, row.startMs));
      found.seg.end_ms = Math.max(found.seg.end_ms, Math.max(0, row.endMs));
      found.seg.text += ` ${row.text}`;
      found.seg.words.push(...words);
      found.rows.push(row.id);
    } else {
      byKey.set(row.key, {
        seg: {
          id: row.key,
          chunk_idx: row.chunkIdx,
          start_ms: Math.max(0, row.startMs),
          end_ms: Math.max(0, row.endMs),
          text: row.text,
          words,
        },
        rows: [row.id],
      });
    }
  }
  return [...byKey.values()];
}

function parseWords(json: string | null): Word[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as Word[]) : [];
  } catch {
    return [];
  }
}

/** Replace this recording's speakers and reattach its segments, in one transaction. */
function persist(
  db: Db,
  recordingId: number,
  labels: string[],
  embeddings: Float32Array[],
  loaded: Loaded[],
  assigned: Assigned[],
): { split: number; unattributed: number } {
  let split = 0;
  let unattributed = 0;

  db.transaction((tx) => {
    const renames = existingNames(tx, recordingId);

    // cascades speaker_id back to NULL on every segment, so nothing points at a stale row
    tx.delete(speakers).where(eq(speakers.recordingId, recordingId)).run();

    const speakerIds = labels.map(
      (label, i) =>
        tx
          .insert(speakers)
          .values({
            recordingId,
            label,
            displayName: renames.get(label) ?? null,
            embedding: embeddings[i] ? toBlob(embeddings[i]) : null,
          })
          .returning({ id: speakers.id })
          .get().id,
    );
    const idOf = (speaker: number | null): number | null =>
      speaker === null ? null : (speakerIds[speaker] ?? null);

    assigned.forEach((item, i) => {
      const current = loaded[i];
      if (!current) return;
      unattributed += item.pieces.filter((p) => p.speaker === null).length;
      if (isSplit(item)) split++;

      // the row survives untouched when the shape has not changed; anything else is rewritten
      // so a re-run always lands on whisper's granularity, never on the last run's
      if (!isSplit(item) && current.rows.length === 1) {
        tx.update(segments)
          .set({ speakerId: idOf(item.pieces[0].speaker) })
          .where(eq(segments.id, current.rows[0]))
          .run();
        return;
      }

      tx.delete(segments).where(inArray(segments.id, current.rows)).run();
      if (item.pieces.length === 0) return;
      tx.insert(segments)
        .values(
          item.pieces.map((piece) => ({
            recordingId,
            chunkIdx: item.chunk_idx,
            startMs: piece.start_ms,
            endMs: piece.end_ms,
            text: piece.text,
            words: JSON.stringify(piece.words),
            speakerId: idOf(piece.speaker),
            splitOf: isSplit(item) ? item.id : null,
          })),
        )
        .run();
    });

    tx.update(recordings)
      .set({ status: "done", stageDetail: null, error: null, updatedAt: now() })
      .where(eq(recordings.id, recordingId))
      .run();
  });

  return { split, unattributed };
}

/**
 * Decision #4 lets users rename speakers per recording. Re-diarizing must not silently throw
 * that away, so names come back by label.
 */
function existingNames(tx: Tx, recordingId: number): Map<string, string> {
  const rows = tx
    .select({ label: speakers.label, displayName: speakers.displayName })
    .from(speakers)
    .where(and(eq(speakers.recordingId, recordingId), isNotNull(speakers.displayName)))
    .all();
  return new Map(rows.map((r) => [r.label, r.displayName as string]));
}

/** Little-endian f32, the same bytes the rust wrote. */
export function toBlob(v: Float32Array): Buffer {
  const out = Buffer.allocUnsafe(v.length * 4);
  for (let i = 0; i < v.length; i++) out.writeFloatLE(v[i], i * 4);
  return out;
}

export function fromBlob(bytes: Buffer): Float32Array {
  const n = bytes.length >> 2; // a trailing partial float is dropped, not misread
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = bytes.readFloatLE(i * 4);
  return out;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
