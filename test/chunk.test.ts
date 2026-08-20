import { describe, expect, it } from "vitest";
import {
  MAX_CHUNK_MS,
  MAX_GAP_MS,
  type Span,
  durationMs,
  pack,
  range,
} from "../src/worker/chunk";
import { CORPUS, chunksOf } from "./fixtures";

describe("pack, against the rust oracle", () => {
  for (const name of CORPUS) {
    it(`reproduces ${name}'s chunk plan exactly`, () => {
      const fixture = chunksOf(name);
      // the constants are part of the plan; a changed default would silently repack
      expect([fixture.max_chunk_ms, fixture.max_gap_ms]).toEqual([MAX_CHUNK_MS, MAX_GAP_MS]);

      const chunks = pack(fixture.spans);
      expect(chunks).toEqual(fixture.chunks);
      expect(chunks.reduce((ms, c) => ms + durationMs(c), 0)).toBe(fixture.speech_ms);
    });

    it(`${name}'s plan holds the invariants the resume logic relies on`, () => {
      const chunks = pack(chunksOf(name).spans);
      chunks.forEach((c, i) => {
        expect(c.idx).toBe(i);
        expect(c.end_ms).toBeGreaterThan(c.start_ms);
        expect(durationMs(c)).toBeLessThanOrEqual(MAX_CHUNK_MS);
        if (i > 0) expect(c.start_ms).toBeGreaterThanOrEqual(chunks[i - 1].end_ms);
      });
    });

    it(`${name} packs identically on a second run`, () => {
      const spans = chunksOf(name).spans;
      expect(pack(spans)).toEqual(pack([...spans]));
    });
  }
});

describe("pack", () => {
  const span = (start_ms: number, end_ms: number): Span => ({ start_ms, end_ms });

  it("is empty for no speech", () => {
    expect(pack([])).toEqual([]);
  });

  it("merges across a gap at the limit and breaks past it", () => {
    expect(pack([span(0, 1000), span(1000 + MAX_GAP_MS, 3000 + MAX_GAP_MS)])).toHaveLength(1);
    expect(pack([span(0, 1000), span(1001 + MAX_GAP_MS, 3000 + MAX_GAP_MS)])).toHaveLength(2);
  });

  it("starts a new chunk rather than exceed the window", () => {
    const chunks = pack([span(0, 25_000), span(25_500, 40_000)]);
    expect(chunks).toEqual([
      { idx: 0, start_ms: 0, end_ms: 25_000 },
      { idx: 1, start_ms: 25_500, end_ms: 40_000 },
    ]);
  });

  it("hard-splits a span longer than the window", () => {
    // 70 s of unbroken speech -> 30 + 30 + 10, and the tail rejoins nothing after it
    expect(pack([span(0, 70_000)])).toEqual([
      { idx: 0, start_ms: 0, end_ms: 30_000 },
      { idx: 1, start_ms: 30_000, end_ms: 60_000 },
      { idx: 2, start_ms: 60_000, end_ms: 70_000 },
    ]);
  });
});

describe("range", () => {
  const chunk = { idx: 0, start_ms: 1000, end_ms: 2000 };

  it("converts ms to sample offsets", () => {
    expect(range(chunk, 100_000)).toEqual({ lo: 16_000, hi: 32_000 });
  });

  it("clamps to what the pcm actually holds", () => {
    expect(range(chunk, 20_000)).toEqual({ lo: 16_000, hi: 20_000 });
    expect(range(chunk, 8_000)).toEqual({ lo: 8_000, hi: 8_000 });
  });
});
