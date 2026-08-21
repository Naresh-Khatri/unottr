// Gives the read side data without running a pipeline (was docs/fixtures/seed.sql).
// Idempotent: clears its own fixed-id rows first. Ids >= 9000 so real rows are never touched.
//
//   pnpm seed                  -> seeds the real database
//   import { seed } from …     -> seeds an in-memory one in tests

import { eq, inArray, like, or } from "drizzle-orm";
import type { Db } from "../src/main/db/client";
import { toBlob } from "../src/main/db/embedding";
import { people, recordings, segments, speakers } from "../src/main/db/schema";

const IDS = [9001, 9002, 9003];
const PREFIX = "/home/naresh/fixtures/";
const PERSON = 9201;

/** Stand-in centroids: unit length in the first two dims, so they are matchable and distinct. */
const voiceprint = (x: number, y: number): Buffer => {
  const v = new Float32Array(192);
  const n = Math.hypot(x, y);
  v[0] = x / n;
  v[1] = y / n;
  return toBlob(v);
};

export function seed(db: Db): void {
  // segments and speakers go with them — the fks are ON DELETE CASCADE
  db.delete(recordings)
    .where(or(inArray(recordings.id, IDS), like(recordings.path, `${PREFIX}%`)))
    .run();

  db.insert(recordings)
    .values([
      {
        // done, multi-speaker, has video, available
        id: 9001,
        path: `${PREFIX}2025-10-06 roadmap-review.mp4`,
        fpSize: 1200000000,
        fpHead: Buffer.from([0xaa]),
        fpTail: Buffer.from([0xbb]),
        container: "mov,mp4,m4a",
        durationMs: 2130000,
        recordedAt: 1759754411,
        status: "done",
        lastChunkIdx: 71,
        createdAt: 1759754411,
        updatedAt: 1759754411,
      },
      {
        // transcribing in flight (progress bar), no speakers yet
        id: 9002,
        path: `${PREFIX}2026-08-18 standup.mp4`,
        fpSize: 900000000,
        fpHead: Buffer.from([0xcc]),
        fpTail: Buffer.from([0xdd]),
        container: "mov,mp4,m4a",
        durationMs: 1980000,
        recordedAt: 1765000332,
        status: "transcribing",
        stageDetail: "chunk 12/44",
        lastChunkIdx: 12,
        createdAt: 1765000332,
        updatedAt: 1765000332,
      },
      {
        // failed (truncated) and unavailable (source deleted) — text still searchable
        id: 9003,
        path: `${PREFIX}2025-10-12 interrupted.mp4`,
        fpSize: 50000000,
        fpHead: Buffer.from([0xee]),
        fpTail: Buffer.from([0xff]),
        container: "mov,mp4,m4a",
        durationMs: null,
        recordedAt: 1760276883,
        status: "failed",
        error: "Truncated",
        attempts: 2,
        available: 0,
        createdAt: 1760276883,
        updatedAt: 1760276883,
      },
    ])
    .run();

  // 9101 is the global case (name comes from `people`), 9102 the anonymous-but-matchable one
  db.delete(people).where(eq(people.id, PERSON)).run();
  db.insert(people)
    .values({
      id: PERSON,
      name: "Priya",
      nameKey: "priya",
      embedding: voiceprint(1, 0),
      samples: 1,
      createdAt: 1759754400,
      updatedAt: 1759754400,
    })
    .run();

  db.insert(speakers)
    .values([
      { id: 9101, recordingId: 9001, label: "Speaker 1", personId: PERSON, embedding: voiceprint(1, 0) },
      { id: 9102, recordingId: 9001, label: "Speaker 2", embedding: voiceprint(0, 1) },
    ])
    .run();

  db.insert(segments)
    .values([
      {
        recordingId: 9001,
        chunkIdx: 0,
        startMs: 1360,
        endMs: 4200,
        text: "Yeah, let's start with the quarterly roadmap review.",
        words: JSON.stringify([
          { text: "Yeah,", start_ms: 1360, end_ms: 1900, p: 0.93 },
          { text: "let's", start_ms: 2100, end_ms: 2600, p: 0.9 },
        ]),
        speakerId: 9101,
      },
      {
        recordingId: 9001,
        chunkIdx: 0,
        startMs: 4200,
        endMs: 7800,
        text: "Sounds good, I pulled the numbers this morning.",
        words: "[]",
        speakerId: 9102,
      },
      {
        recordingId: 9001,
        chunkIdx: 1,
        startMs: 7800,
        endMs: 11200,
        text: "Great, walk me through the search latency first.",
        words: "[]",
        speakerId: 9101,
      },
      // unattributed segment (speaker_id null) to exercise that render path
      { recordingId: 9001, chunkIdx: 1, startMs: 11200, endMs: 13000, text: "(crosstalk)", words: "[]" },
      {
        recordingId: 9003,
        chunkIdx: 0,
        startMs: 500,
        endMs: 3200,
        text: "This recording was interrupted mid-call.",
        words: "[]",
      },
    ])
    .run();
}

if (process.argv[1]?.endsWith("seed.ts")) {
  const { db } = await import("../src/main/db");
  seed(db());
  console.log("seeded 9001-9003");
}
