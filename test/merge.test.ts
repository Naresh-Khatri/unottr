import { describe, expect, it } from "vitest";
import { type Segment, assign, isSplit, overlap, tied } from "../src/worker/merge";
import type { Turn } from "../src/worker/types";
import type { Word } from "../src/worker/whisper";
import { CORPUS, mergedOf, turnsOf } from "./fixtures";

describe("assign, against the rust oracle", () => {
  for (const name of CORPUS) {
    it(`reproduces ${name}'s attribution exactly, split points included`, () => {
      const { segments, assigned } = mergedOf(name);
      expect(assign(segments, turnsOf(name).turns)).toEqual(assigned);
    });

    it(`re-running merge on ${name}'s own output is a no-op`, () => {
      const { assigned } = mergedOf(name);
      const turns = turnsOf(name).turns;

      // what a second diarization run sees: every piece is now a row of its own
      const again = assign(
        assigned.flatMap((item) =>
          item.pieces.map((piece) => ({
            id: item.id,
            chunk_idx: item.chunk_idx,
            start_ms: piece.start_ms,
            end_ms: piece.end_ms,
            text: piece.text,
            words: piece.words,
          })),
        ),
        turns,
      );

      expect(again.map((a) => a.pieces)).toEqual(
        assigned.flatMap((item) => item.pieces.map((piece) => [piece])),
      );
    });
  }
});

describe("assign", () => {
  const word = (text: string, start_ms: number, end_ms: number): Word => ({
    text,
    start_ms,
    end_ms,
    p: null,
  });
  const seg = (words: Word[], start_ms?: number, end_ms?: number): Segment => ({
    id: 1,
    chunk_idx: 0,
    start_ms: start_ms ?? words[0].start_ms,
    end_ms: end_ms ?? words[words.length - 1].end_ms,
    text: words.map((w) => w.text).join(" "),
    words,
  });
  const turn = (start_ms: number, end_ms: number, speaker: number): Turn => ({
    start_ms,
    end_ms,
    speaker,
  });

  it("leaves a segment no turn touches unattributed", () => {
    const [out] = assign([seg([word("hello", 0, 500)])], [turn(9_000, 10_000, 0)]);
    expect(out.pieces).toHaveLength(1);
    expect(out.pieces[0].speaker).toBeNull();
    expect(isSplit(out)).toBe(false);
  });

  it("keeps whisper's own text when nothing is split", () => {
    const segment = seg([word("one", 0, 500), word("two.", 500, 1000)]);
    segment.text = "One two.";
    const [out] = assign([segment], [turn(0, 1000, 3)]);
    expect(out.pieces).toEqual([
      { start_ms: 0, end_ms: 1000, text: "One two.", words: segment.words, speaker: 3 },
    ]);
  });

  it("sums a speaker's turns rather than picking their longest", () => {
    // speaker 1 holds 600 ms across two turns, speaker 0 holds 500 in one
    const [out] = assign(
      [seg([word("a", 0, 1000)], 0, 1100)],
      [turn(0, 300, 1), turn(300, 800, 0), turn(800, 1100, 1)],
    );
    expect(out.pieces[0].speaker).toBe(1);
  });

  it("splits at the word nearest the handover and rebuilds both halves", () => {
    const words = [word("Aye", 0, 400), word("Bee", 500, 900), word("Sea", 1000, 1400)];
    const [out] = assign([seg(words, 0, 1400)], [turn(0, 700, 0), turn(700, 1400, 1)]);

    expect(out.pieces).toHaveLength(2);
    expect(out.pieces.map((p) => p.speaker)).toEqual([0, 1]);
    expect(out.pieces.map((p) => p.text)).toEqual(["Aye", "Bee Sea"]);
    // the halves cover every word exactly once
    expect(out.pieces.flatMap((p) => p.words)).toEqual(words);
  });

  it("does not split when one speaker clearly dominates", () => {
    const words = [word("a", 0, 400), word("b", 500, 900), word("c", 1000, 1400)];
    const [out] = assign([seg(words, 0, 1400)], [turn(0, 1300, 0), turn(1300, 1400, 1)]);
    expect(out.pieces).toHaveLength(1);
    expect(out.pieces[0].speaker).toBe(0);
  });

  it("never splits a single word", () => {
    const [out] = assign([seg([word("mm", 0, 1000)])], [turn(0, 500, 0), turn(500, 1000, 1)]);
    expect(out.pieces).toHaveLength(1);
  });

  it("coalesces halves that resolved to the same speaker", () => {
    const words = [word("a", 0, 400), word("b", 500, 900), word("c", 1000, 1400)];
    // one speaker either side of a third's brief interjection: the split buys nothing
    const [out] = assign(
      [seg(words, 0, 1400)],
      [turn(0, 600, 0), turn(600, 800, 1), turn(800, 1400, 0)],
    );
    expect(out.pieces).toHaveLength(1);
    expect(out.pieces[0].speaker).toBe(0);
  });

  it("breaks ties on speaker id, so the same input always assigns the same way", () => {
    const [out] = assign([seg([word("x", 0, 1000)])], [turn(0, 500, 7), turn(500, 1000, 2)]);
    expect(out.pieces[0].speaker).toBe(2);
  });
});

describe("overlap", () => {
  it("is the intersection length, zero when disjoint or touching", () => {
    expect(overlap(0, 100, 50, 150)).toBe(50);
    expect(overlap(0, 100, 100, 200)).toBe(0);
    expect(overlap(0, 100, 200, 300)).toBe(0);
    expect(overlap(0, 100, 20, 40)).toBe(20);
  });
});

describe("tied", () => {
  it("holds within 20% of the leader and never for a leader of zero", () => {
    expect(tied(100, 80)).toBe(true);
    expect(tied(100, 79)).toBe(false);
    expect(tied(0, 0)).toBe(false);
  });
});
