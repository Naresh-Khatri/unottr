// The database half of the pipeline, with a scripted worker in place of the real one. What
// matters here is the crash contract: `last_chunk_idx` must never name a chunk whose segments
// are missing, and a resumed run must neither duplicate nor lose one.

import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, openDatabase } from "../src/main/db/client";
import { runMigrations } from "../src/main/db/migrate";
import { now } from "../src/main/db/recordings";
import { recordings, segments, speakers } from "../src/main/db/schema";
import { PipelineError } from "../src/main/errors";
import {
  type DiarizeSpec,
  type TranscribeSpec,
  diarize,
  fromBlob,
  toBlob,
  transcribe,
} from "../src/main/ingest/pipeline";
import type { Chunk } from "../src/worker/chunk";
import type { Assigned } from "../src/worker/merge";
import type { Reply, Request, TranscribeJob } from "../src/worker/protocol";
import type { Utterance, Word } from "../src/worker/whisper";

/** Stands in for a utilityProcess. `respond` is whatever script the test is running. */
class Fake extends EventEmitter {
  static forks: Fake[] = [];
  static respond: (fake: Fake, request: Request) => void = () => {};

  killed = false;
  requests: Request[] = [];

  constructor() {
    super();
    Fake.forks.push(this);
    queueMicrotask(() => this.emit("spawn"));
  }

  postMessage(request: Request): void {
    this.requests.push(request);
    // main sends the job on spawn and `cancel` later; only the job draws a reply
    if (request.type !== "cancel") queueMicrotask(() => Fake.respond(this, request));
  }

  kill(): void {
    this.killed = true;
  }

  reply(reply: Reply): void {
    this.emit("message", reply);
  }
}

vi.mock("electron", () => ({ utilityProcess: { fork: () => new Fake() } }));

const ID = 1;
const CHUNKS: Chunk[] = [
  { idx: 0, start_ms: 0, end_ms: 10_000 },
  { idx: 1, start_ms: 10_000, end_ms: 20_000 },
  { idx: 2, start_ms: 20_000, end_ms: 25_000 },
];

const word = (text: string, start_ms: number): Word => ({
  text,
  start_ms,
  end_ms: start_ms + 400,
  p: null,
});

/** One utterance per chunk, so a chunk index is readable straight off the text. */
const utteranceFor = (chunk: Chunk): Utterance => ({
  start_ms: chunk.start_ms,
  end_ms: chunk.start_ms + 1000,
  text: `chunk ${chunk.idx}.`,
  words: [word("chunk", chunk.start_ms), word(`${chunk.idx}.`, chunk.start_ms + 500)],
});

const spec: TranscribeSpec = {
  recordingId: ID,
  pcm: "/tmp/does-not-exist.pcm",
  model: "/models/whisper.bin",
  vadModel: "/models/vad.bin",
  device: "gpu",
  options: { language: null, threads: 4, translate: false },
};

const diarizeSpec: DiarizeSpec = {
  recordingId: ID,
  pcm: spec.pcm,
  micPcm: null,
  segmentation: "/models/seg.onnx",
  embedding: "/models/emb.onnx",
  vadModel: spec.vadModel,
  config: { threshold: 0.6, speakers: null },
};

/** Replies with the whole plan, then the chunks named, then `transcribed` unless cut short. */
const scriptedRun = (upTo: number, crashAfter = false) => {
  Fake.respond = (fake, request) => {
    if (request.type !== "transcribe") return;
    fake.reply({ type: "plan", chunks: CHUNKS });
    for (const chunk of CHUNKS.slice(request.job.from, upTo)) {
      fake.reply({ type: "chunk", idx: chunk.idx, utterances: [utteranceFor(chunk)] });
    }
    if (crashAfter) fake.emit("exit", 134);
    else fake.reply({ type: "transcribed" });
  };
};

let db: Db;

const rows = (): { chunkIdx: number; text: string; startMs: number }[] =>
  db
    .select({ chunkIdx: segments.chunkIdx, text: segments.text, startMs: segments.startMs })
    .from(segments)
    .where(eq(segments.recordingId, ID))
    .orderBy(segments.startMs)
    .all();

const recording = () => db.select().from(recordings).where(eq(recordings.id, ID)).get()!;

beforeEach(() => {
  Fake.forks = [];
  Fake.respond = () => {};
  db = openDatabase(":memory:");
  runMigrations(db);
  db.insert(recordings)
    .values({
      id: ID,
      path: "/recordings/meeting.mp4",
      fpSize: 1,
      fpHead: Buffer.alloc(32),
      fpTail: Buffer.alloc(32),
      status: "transcribing",
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
});

describe("transcribe", () => {
  it("checkpoints every chunk and hands the recording to diarization", async () => {
    scriptedRun(CHUNKS.length);
    const seen: number[] = [];
    const report = await transcribe(db, spec, (f) => seen.push(f));

    expect(report).toEqual({
      device: "gpu",
      chunks: 3,
      resumedFrom: 0,
      segments: 3,
      speechMs: 25_000,
    });
    expect(seen).toEqual([1 / 3, 2 / 3, 1]);
    expect(rows().map((r) => r.text)).toEqual(["chunk 0.", "chunk 1.", "chunk 2."]);
    expect(recording()).toMatchObject({ status: "diarizing", stageDetail: null, lastChunkIdx: 2 });
  });

  it("stores each utterance's words as json", async () => {
    scriptedRun(1);
    Fake.respond = (fake, request) => {
      if (request.type !== "transcribe") return;
      fake.reply({ type: "plan", chunks: [CHUNKS[0]] });
      fake.reply({ type: "chunk", idx: 0, utterances: [utteranceFor(CHUNKS[0])] });
      fake.reply({ type: "transcribed" });
    };
    await transcribe(db, spec, () => {});

    const stored = db.select({ words: segments.words }).from(segments).get()!;
    expect(JSON.parse(stored.words!)).toEqual(utteranceFor(CHUNKS[0]).words);
  });

  it("leaves a consistent checkpoint when the worker dies mid-run", async () => {
    // a `kill -9` never reaches the message channel; main only sees the process exit
    scriptedRun(2, true);
    await expect(transcribe(db, spec, () => {})).rejects.toBeInstanceOf(PipelineError);

    expect(rows().map((r) => r.chunkIdx)).toEqual([0, 1]);
    expect(recording()).toMatchObject({
      status: "transcribing",
      stageDetail: "chunk 1",
      lastChunkIdx: 1,
    });
  });

  it("blames the stage the dead worker was running", async () => {
    scriptedRun(0, true);
    await expect(transcribe(db, spec, () => {})).rejects.toMatchObject({
      detail: { kind: "whisper_failed" },
    });
    Fake.respond = (fake) => fake.emit("exit", 1);
    await expect(diarize(db, diarizeSpec, () => {})).rejects.toMatchObject({
      detail: { kind: "diarize_failed" },
    });
  });

  it("resumes from the checkpoint without redoing or duplicating a chunk", async () => {
    scriptedRun(2, true);
    await expect(transcribe(db, spec, () => {})).rejects.toThrow();

    scriptedRun(CHUNKS.length);
    const report = await transcribe(db, spec, () => {});

    expect(report.resumedFrom).toBe(2);
    expect((Fake.forks.at(-1)!.requests[0] as { job: TranscribeJob }).job.from).toBe(2);
    expect(rows().map((r) => r.text)).toEqual(["chunk 0.", "chunk 1.", "chunk 2."]);
  });

  it("drops segments past the checkpoint before restarting", async () => {
    // the window a crash can land in: chunk 2's rows written, `last_chunk_idx` not yet moved
    scriptedRun(2, true);
    await expect(transcribe(db, spec, () => {})).rejects.toThrow();
    db.insert(segments)
      .values({ recordingId: ID, chunkIdx: 2, startMs: 20_000, endMs: 21_000, text: "orphan" })
      .run();

    scriptedRun(CHUNKS.length);
    await transcribe(db, spec, () => {});
    expect(rows().map((r) => r.text)).toEqual(["chunk 0.", "chunk 1.", "chunk 2."]);
  });

  it("starts over when nothing was ever checkpointed", async () => {
    db.insert(segments)
      .values({ recordingId: ID, chunkIdx: 0, startMs: 0, endMs: 1000, text: "orphan" })
      .run();
    db.update(recordings).set({ lastChunkIdx: null }).where(eq(recordings.id, ID)).run();

    scriptedRun(CHUNKS.length);
    const report = await transcribe(db, spec, () => {});
    expect(report.resumedFrom).toBe(0);
    expect(rows().map((r) => r.text)).toEqual(["chunk 0.", "chunk 1.", "chunk 2."]);
  });

  it("forwards a cancel and kills the worker either way", async () => {
    const controller = new AbortController();
    Fake.respond = (fake, request) => {
      if (request.type !== "transcribe") return;
      fake.reply({ type: "plan", chunks: CHUNKS });
      fake.reply({ type: "chunk", idx: 0, utterances: [] });
      controller.abort();
      // the real worker turns an abort into `cancelled`; main just relays the request
      queueMicrotask(() =>
        fake.reply({ type: "failed", error: { kind: "cancelled" } }),
      );
    };

    await expect(transcribe(db, spec, () => {}, controller.signal)).rejects.toMatchObject({
      detail: { kind: "cancelled" },
    });
    const fake = Fake.forks.at(-1)!;
    expect(fake.requests.at(-1)).toEqual({ type: "cancel" });
    expect(fake.killed).toBe(true);
  });

  it("kills the worker after a clean run too — it is holding vram", async () => {
    scriptedRun(CHUNKS.length);
    await transcribe(db, spec, () => {});
    expect(Fake.forks).toHaveLength(1);
    expect(Fake.forks[0].killed).toBe(true);
  });
});

describe("diarize", () => {
  const embedding = (fill: number): Float32Array => new Float32Array([fill, fill + 0.5]);

  /** Attributes the segments it is given, splitting the one named. */
  const scriptedDiarize = (assignedOf: (sent: Assigned[]) => Assigned[], labels = ["A", "B"]) => {
    Fake.respond = (fake, request) => {
      if (request.type !== "diarize") return;
      fake.reply({ type: "progress", pct: 0.5 });
      const sent = request.job.segments.map((s) => ({
        id: s.id,
        chunk_idx: s.chunk_idx,
        pieces: [
          { start_ms: s.start_ms, end_ms: s.end_ms, text: s.text, words: s.words, speaker: 0 },
        ],
      }));
      fake.reply({
        type: "diarized",
        labels,
        embeddings: labels.map((_, i) => embedding(i)),
        assigned: assignedOf(sent),
      });
    };
  };

  const insertSegment = (values: Partial<typeof segments.$inferInsert>): number =>
    db
      .insert(segments)
      .values({
        recordingId: ID,
        chunkIdx: 0,
        startMs: 0,
        endMs: 1000,
        text: "hello",
        words: "[]",
        ...values,
      })
      .returning({ id: segments.id })
      .get().id;

  it("attaches speakers, embeddings and the final status", async () => {
    insertSegment({ startMs: 0, endMs: 1000, text: "one" });
    insertSegment({ startMs: 1000, endMs: 2000, text: "two" });
    scriptedDiarize((sent) => sent);

    const seen: number[] = [];
    const report = await diarize(db, diarizeSpec, (f) => seen.push(f));

    expect(report).toEqual({ speakers: 2, segments: 2, split: 0, unattributed: 0, micTrack: false });
    expect(seen).toEqual([0.5, 1]);

    const people = db.select().from(speakers).where(eq(speakers.recordingId, ID)).all();
    expect(people.map((p) => p.label)).toEqual(["A", "B"]);
    expect([...fromBlob(people[0].embedding!)]).toEqual([0, 0.5]);
    expect(
      db
        .select({ speakerId: segments.speakerId })
        .from(segments)
        .all()
        .every((s) => s.speakerId === people[0].id),
    ).toBe(true);
    expect(recording()).toMatchObject({ status: "done", error: null });
  });

  it("keeps a segment that did not split as the same row", async () => {
    const id = insertSegment({});
    scriptedDiarize((sent) => sent);
    await diarize(db, diarizeSpec, () => {});
    expect(db.select({ id: segments.id }).from(segments).all()).toEqual([{ id }]);
  });

  it("rewrites a split segment into pieces that point back at it", async () => {
    const id = insertSegment({ startMs: 0, endMs: 2000, text: "one two" });
    scriptedDiarize((sent) =>
      sent.map((a) => ({
        ...a,
        pieces: [
          { start_ms: 0, end_ms: 1000, text: "one", words: [], speaker: 0 },
          { start_ms: 1000, end_ms: 2000, text: "two", words: [], speaker: 1 },
        ],
      })),
    );

    const report = await diarize(db, diarizeSpec, () => {});
    expect(report.split).toBe(1);

    const after = db.select().from(segments).orderBy(segments.startMs).all();
    expect(after.map((s) => [s.text, s.splitOf])).toEqual([
      ["one", id],
      ["two", id],
    ]);
    expect(after[0].speakerId).not.toBe(after[1].speakerId);
  });

  it("reassembles a previous run's pieces before re-attributing them", async () => {
    const id = insertSegment({ startMs: 0, endMs: 1000, text: "one", words: '[{"text":"one"}]' });
    insertSegment({ startMs: 1000, endMs: 2000, text: "two", splitOf: id, words: "[]" });
    insertSegment({ startMs: 2000, endMs: 3000, text: "three", splitOf: id, words: "[]" });

    let sentIn: { id: number; text: string; start_ms: number; end_ms: number }[] = [];
    Fake.respond = (fake, request) => {
      if (request.type !== "diarize") return;
      sentIn = request.job.segments;
      fake.reply({
        type: "diarized",
        labels: ["A"],
        embeddings: [embedding(0)],
        assigned: request.job.segments.map((s) => ({
          id: s.id,
          chunk_idx: s.chunk_idx,
          pieces: [
            { start_ms: s.start_ms, end_ms: s.end_ms, text: s.text, words: s.words, speaker: 0 },
          ],
        })),
      });
    };

    const report = await diarize(db, diarizeSpec, () => {});
    // one logical segment, whole again, not three
    expect(sentIn).toEqual([
      { id, chunk_idx: 0, start_ms: 0, end_ms: 3000, text: "one two three", words: [{ text: "one" }] },
    ]);
    expect(report.segments).toBe(1);
    expect(db.select({ text: segments.text }).from(segments).all()).toEqual([
      { text: "one two three" },
    ]);
  });

  it("counts unattributed pieces without inventing a speaker for them", async () => {
    insertSegment({});
    scriptedDiarize((sent) =>
      sent.map((a) => ({ ...a, pieces: a.pieces.map((p) => ({ ...p, speaker: null })) })),
    );
    const report = await diarize(db, diarizeSpec, () => {});
    expect(report.unattributed).toBe(1);
    expect(db.select({ speakerId: segments.speakerId }).from(segments).get()!.speakerId).toBeNull();
  });

  it("carries a user's speaker rename across a re-run, by label", async () => {
    insertSegment({});
    db.insert(speakers)
      .values({ recordingId: ID, label: "A", displayName: "Priya" })
      .run();
    scriptedDiarize((sent) => sent);

    await diarize(db, diarizeSpec, () => {});
    const people = db.select().from(speakers).where(eq(speakers.recordingId, ID)).all();
    expect(people.map((p) => [p.label, p.displayName])).toEqual([
      ["A", "Priya"],
      ["B", null],
    ]);
  });
});

describe("toBlob and fromBlob", () => {
  it("round-trips an embedding as little-endian f32", () => {
    const v = new Float32Array([1, -0.5, 0.25]);
    const blob = toBlob(v);
    expect(blob.length).toBe(12);
    expect(blob.readFloatLE(4)).toBe(-0.5);
    expect([...fromBlob(blob)]).toEqual([...v]);
  });

  it("drops a trailing partial float rather than reading past the end", () => {
    expect(fromBlob(Buffer.concat([toBlob(new Float32Array([1])), Buffer.from([0, 0])]))).toEqual(
      new Float32Array([1]),
    );
  });
});
