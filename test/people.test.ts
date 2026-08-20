// Global speaker identity: the matching rules, and what naming a speaker does to the people
// table. The point of the whole thing is that a name survives the recording it was typed in.

import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { type Db, openDatabase } from "../src/main/db/client";
import { fromBlob, toBlob } from "../src/main/db/embedding";
import { runMigrations } from "../src/main/db/migrate";
import * as p from "../src/main/db/people";
import * as q from "../src/main/db/queries";
import { people, recordings, speakers } from "../src/main/db/schema";

const unit = (x: number, y: number): Float32Array => {
  const n = Math.hypot(x, y);
  return new Float32Array([x / n, y / n]);
};

describe("identify", () => {
  const known = [
    { id: 1, embedding: unit(1, 0) },
    { id: 2, embedding: unit(0, 1) },
  ];

  it("matches a centroid inside the cut and leaves the rest alone", () => {
    expect(p.identify([unit(1, 0.05), unit(-1, 0)], known)).toEqual([1, null]);
  });

  it("stays quiet when two voiceprints are equally close", () => {
    // 45° from both -> the margin rule fires and nobody is named
    expect(p.identify([unit(1, 1)], known)).toEqual([null]);
  });

  it("hands a person to one speaker only, nearest first", () => {
    expect(p.identify([unit(1, 0.4), unit(1, 0)], [known[0]])).toEqual([null, 1]);
  });

  it("skips clusters that never embedded, and any recording when nobody is known", () => {
    expect(p.identify([null, unit(1, 0)], known)).toEqual([null, 1]);
    expect(p.identify([unit(1, 0)], [])).toEqual([null]);
  });
});

describe("fold", () => {
  it("starts from the first centroid, normalized", () => {
    expect([...p.fold(null, 0, new Float32Array([0, 4]))]).toEqual([0, 1]);
  });

  it("is a running mean, so an old voiceprint outweighs one new sample", () => {
    const folded = p.fold(unit(1, 0), 9, unit(0, 1));
    expect(folded[0]).toBeGreaterThan(folded[1]);
    expect(Math.hypot(folded[0], folded[1])).toBeCloseTo(1, 5);
  });
});

describe("naming a speaker", () => {
  let db: Db;

  const speaker = (label: string, embedding: Float32Array | null, recordingId = 1): number => {
    db.insert(recordings)
      .values({
        id: recordingId,
        path: `/rec/${recordingId}.mp4`,
        fpSize: 1,
        fpHead: Buffer.from([1]),
        fpTail: Buffer.from([2]),
        status: "done",
        createdAt: 0,
        updatedAt: 0,
      })
      .onConflictDoNothing()
      .run();
    return db
      .insert(speakers)
      .values({ recordingId, label, embedding: embedding ? toBlob(embedding) : null })
      .returning({ id: speakers.id })
      .get().id;
  };

  const row = (id: number) => db.select().from(speakers).where(eq(speakers.id, id)).get();

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  it("creates the person and enrolls the cluster as their voiceprint", () => {
    const id = speaker("Speaker 1", unit(1, 0));
    p.nameSpeaker(db, id, "Priya");

    const [person] = p.list(db);
    expect(person).toMatchObject({ name: "Priya", samples: 1, recordings: 1 });
    expect(row(id)).toMatchObject({ personId: person.id, displayName: null });
    expect([...fromBlob(db.select().from(people).get()!.embedding!)]).toEqual([1, 0]);
  });

  it("folds a second recording's cluster into the same person, matched by name", () => {
    p.nameSpeaker(db, speaker("Speaker 1", unit(1, 0)), "Priya");
    p.nameSpeaker(db, speaker("Speaker 1", unit(1, 0.2), 2), "  priya ");

    const list = p.list(db);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "priya", samples: 2, recordings: 2 });
  });

  it("names a cluster that never embedded locally, with no person behind it", () => {
    const id = speaker("Speaker 1", null);
    p.nameSpeaker(db, id, "Ghost");
    expect(row(id)).toMatchObject({ displayName: "Ghost", personId: null });
    expect(p.list(db)).toEqual([]);
  });

  it("clears both halves on an empty name", () => {
    const id = speaker("Speaker 1", unit(1, 0));
    p.nameSpeaker(db, id, "Priya");
    p.nameSpeaker(db, id, "   ");
    expect(row(id)).toMatchObject({ displayName: null, personId: null });
    // the voiceprint stays: unnaming one speaker is not forgetting the person
    expect(p.list(db)[0]).toMatchObject({ name: "Priya", recordings: 0 });
  });

  it("throws on a stale speaker id", () => {
    expect(() => p.nameSpeaker(db, 404, "Nobody")).toThrow();
  });

  it("resolves the person's name through getRecording, not the stored label", () => {
    const id = speaker("Speaker 1", unit(1, 0));
    p.nameSpeaker(db, id, "Priya");
    expect(q.getRecording(db, 1)?.speakers).toEqual([
      { id, recording_id: 1, label: "Speaker 1", display_name: "Priya", person_id: expect.any(Number) },
    ]);
  });

  describe("editing people", () => {
    it("renames everywhere at once", () => {
      const id = speaker("Speaker 1", unit(1, 0));
      p.nameSpeaker(db, id, "Priya");
      p.rename(db, p.list(db)[0].id, "Priya R");
      expect(q.getRecording(db, 1)?.speakers[0].display_name).toBe("Priya R");
    });

    it("refuses to rename onto someone else, and refuses an empty name", () => {
      p.nameSpeaker(db, speaker("Speaker 1", unit(1, 0)), "Priya");
      p.nameSpeaker(db, speaker("Speaker 2", unit(0, 1)), "Sam");
      const sam = p.list(db).find((x) => x.name === "Sam")!;
      expect(() => p.rename(db, sam.id, "priya")).toThrow();
      expect(() => p.rename(db, sam.id, " ")).toThrow();
    });

    it("forgetting drops the voiceprint and unnames their speakers", () => {
      const id = speaker("Speaker 1", unit(1, 0));
      p.nameSpeaker(db, id, "Priya");
      p.forget(db, p.list(db)[0].id);

      expect(p.list(db)).toEqual([]);
      expect(p.voiceprints(db)).toEqual([]);
      expect(q.getRecording(db, 1)?.speakers[0].display_name).toBeNull();
    });
  });
});
