// The numeric heart of diarization: everything here decides how many people were in the
// room. No models, so it is all reachable from a unit test, and the fixture centroids are
// real CAM++ output rather than made-up vectors.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_THRESHOLD,
  FRAGMENT_THRESHOLD,
  MIN_SPEAKER_MS,
  type RawSegment,
  agglomerate,
  applyLabels,
  fragmentCount,
  isEmbedded,
  midpoint,
  nearest,
  normalize,
  pruneTinySpeakers,
  relabel,
  renumber,
} from "../src/worker/cluster";
import type { Turn } from "../src/worker/types";
import { CORPUS, turnsOf } from "./fixtures";

const turn = (start_ms: number, end_ms: number, speaker: number): Turn => ({
  start_ms,
  end_ms,
  speaker,
});

const vec = (...xs: number[]): Float32Array => normalize(new Float32Array(xs));

/** Groups as sets of member indices, so a partition can be compared without id order. */
const partition = (labels: number[]): number[][] => {
  const groups = new Map<number, number[]>();
  labels.forEach((id, i) => groups.set(id, [...(groups.get(id) ?? []), i]));
  return [...groups.values()].map((g) => [...g].sort((a, b) => a - b)).sort((a, b) => a[0] - b[0]);
};

// deterministic; a seeded lcg beats Math.random when a failure has to be reproducible
function noisy(source: number[], seed: number, scale: number): Float32Array {
  let state = seed;
  const out = new Float32Array(source.length);
  for (let i = 0; i < source.length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[i] = source[i] + (state / 0xffffffff - 0.5) * scale;
  }
  return normalize(out);
}

describe("relabel", () => {
  const raw = (start: number, end: number, speaker: number): RawSegment => ({
    start,
    end,
    speaker,
  });

  it("converts seconds to whole ms", () => {
    expect(relabel([raw(1.2345, 2.9999, 4)])).toEqual([{ start_ms: 1234, end_ms: 2999, speaker: 0 }]);
  });

  it("does the *1000 in f32, as the rust did", () => {
    // 0.005 as f32 is a hair under 5 ms; f32 rounds the product back up to exactly 5000,
    // f64 keeps the shortfall and truncates to 4. one such turn moves a fragment's clip.
    expect(relabel([raw(Math.fround(0.005), 1, 0)])[0].start_ms).toBe(5);
  });

  it("numbers speakers by first appearance, not by sherpa's cluster ids", () => {
    // sorted by start first, so speaker 3 opens and takes id 0 however sherpa numbered it
    const out = relabel([raw(5, 6, 9), raw(0, 1, 3), raw(2, 3, 9), raw(4, 5, 3)]);
    expect(out.map((t) => t.speaker)).toEqual([0, 1, 0, 1]);
  });

  it("sorts by start, then by end", () => {
    const out = relabel([raw(1, 5, 0), raw(1, 2, 1), raw(0, 9, 2)]);
    expect(out.map((t) => [t.start_ms, t.end_ms])).toEqual([
      [0, 9000],
      [1000, 2000],
      [1000, 5000],
    ]);
  });

  it("drops empty and inverted segments and clamps negative starts", () => {
    expect(relabel([raw(1, 1, 0), raw(2, 1, 0)])).toEqual([]);
    expect(relabel([raw(-1, 1, 0)])).toEqual([{ start_ms: 0, end_ms: 1000, speaker: 0 }]);
  });

  it("is empty for no segments", () => {
    expect(relabel([])).toEqual([]);
  });

  for (const name of CORPUS) {
    it(`round-trips ${name}'s turns from the oracle`, () => {
      const turns = turnsOf(name).turns;
      const back = relabel(turns.map((t) => raw(t.start_ms / 1000, t.end_ms / 1000, t.speaker)));
      expect(back.map((t) => t.speaker)).toEqual(turns.map((t) => t.speaker));
      // seconds is a lossy intermediate; only the ids and ordering have to survive exactly
      back.forEach((t, i) => {
        expect(Math.abs(t.start_ms - turns[i].start_ms)).toBeLessThanOrEqual(1);
        expect(Math.abs(t.end_ms - turns[i].end_ms)).toBeLessThanOrEqual(1);
      });
    });
  }
});

describe("fragmentCount", () => {
  it("is one past the highest id, not the number of distinct ones", () => {
    expect(fragmentCount([])).toBe(0);
    expect(fragmentCount([turn(0, 1, 0), turn(1, 2, 3)])).toBe(4);
  });
});

describe("normalize", () => {
  it("scales to unit length in place", () => {
    const v = new Float32Array([3, 4]);
    expect(normalize(v)).toBe(v);
    expect(v[0]).toBeCloseTo(0.6, 6);
    expect(v[1]).toBeCloseTo(0.8, 6);
  });

  it("leaves a zero vector alone rather than producing NaN", () => {
    expect([...normalize(new Float32Array(4))]).toEqual([0, 0, 0, 0]);
  });

  it("leaves a vector below f32 epsilon alone", () => {
    const v = new Float32Array([1e-10, 0]);
    const before = [...v];
    expect([...normalize(v)]).toEqual(before);
  });

  for (const name of CORPUS) {
    it(`is a no-op on ${name}'s stored centroids`, () => {
      for (const e of turnsOf(name).embeddings) {
        const v = normalize(new Float32Array(e));
        v.forEach((x, i) => expect(Math.abs(x - e[i])).toBeLessThan(1e-6));
      }
    });
  }
});

describe("agglomerate", () => {
  it("re-clusters looser than sherpa fragmented", () => {
    // the whole point of the second pass: sherpa cuts at 0.5 and shatters a speaker, we
    // rejoin at 0.6. a change that inverts these two would silently undo it
    expect(FRAGMENT_THRESHOLD).toBeLessThan(DEFAULT_THRESHOLD);
  });

  it("handles the degenerate sizes", () => {
    expect(agglomerate([], DEFAULT_THRESHOLD)).toEqual([]);
    expect(agglomerate([vec(1, 0)], DEFAULT_THRESHOLD)).toEqual([0]);
  });

  it("merges identical vectors and keeps orthogonal ones apart", () => {
    expect(agglomerate([vec(1, 0), vec(1, 0)], DEFAULT_THRESHOLD)).toEqual([0, 0]);
    // orthogonal = distance 1, past every threshold we use
    expect(agglomerate([vec(1, 0), vec(0, 1)], DEFAULT_THRESHOLD)).toEqual([0, 1]);
  });

  it("cuts strictly below the threshold", () => {
    // distance is exactly 0.5, so a 0.5 threshold must not merge and 0.51 must
    const pair = [vec(1, 0), vec(0.5, Math.sqrt(3) / 2)];
    expect(agglomerate(pair, 0.5)).toEqual([0, 1]);
    expect(agglomerate([vec(1, 0), vec(0.5, Math.sqrt(3) / 2)], 0.51)).toEqual([0, 0]);
  });

  it("numbers groups by their first surviving member", () => {
    const labels = agglomerate([vec(1, 0), vec(0, 1), vec(1, 0.01), vec(0, 1)], 0.1);
    expect(labels).toEqual([0, 1, 0, 1]);
  });

  it("averages rather than taking the worst pair, unlike sherpa's own clustering", () => {
    // a and c sit 0.28 apart; b is between them. complete-linkage would refuse at 0.2,
    // average-linkage joins b to whichever it is closer to and then absorbs the third
    const a = vec(1, 0);
    const b = vec(Math.cos(0.53), Math.sin(0.53));
    const c = vec(Math.cos(0.77), Math.sin(0.77));
    expect(partition(agglomerate([a, b, c], 0.25))).toEqual([[0, 1, 2]]);
  });

  it("puts everything in one group at a threshold nothing can exceed", () => {
    const vs = [vec(1, 0), vec(0, 1), vec(-1, 0), vec(0, -1)];
    expect(agglomerate(vs, 3)).toEqual([0, 0, 0, 0]);
  });

  it("is order-independent", () => {
    const vs = [vec(1, 0, 0), vec(0.99, 0.1, 0), vec(0, 1, 0), vec(0, 0.99, 0.1), vec(0, 0, 1)];
    const straight = partition(agglomerate(vs, 0.2));
    const shuffled = [vs[4], vs[2], vs[0], vs[3], vs[1]];
    const back = [4, 2, 0, 3, 1]; // shuffled index -> original index
    const remapped = partition(agglomerate(shuffled, 0.2))
      .map((g) => g.map((i) => back[i]).sort((a, b) => a - b))
      .sort((x, y) => x[0] - y[0]);
    expect(remapped).toEqual(straight);
  });

  describe("on the oracle's centroids", () => {
    // These are final per-speaker centroids, not the fragment centroids the real run
    // clustered, so the cut that separates them is a property of this data rather than a
    // claim about the default. Each is set just under that recording's closest pair.
    const cuts: [string, number][] = [
      ["corpus-01", 0.5], // closest pair 0.539
      ["corpus-02", DEFAULT_THRESHOLD], // 0.657
      ["corpus-03", 0.5], // 0.512
    ];

    for (const [name, cut] of cuts) {
      it(`keeps ${name}'s speakers apart at ${cut}`, () => {
        const centroids = turnsOf(name).embeddings.map((e) => new Float32Array(e));
        expect(agglomerate(centroids, cut)).toEqual(centroids.map((_, i) => i));
      });

      it(`rejoins a noisy copy of each of ${name}'s speakers`, () => {
        const source = turnsOf(name).embeddings;
        const centroids = [
          ...source.map((e) => new Float32Array(e)),
          ...source.map((e, i) => noisy(e, i + 1, 0.05)),
        ];
        const labels = agglomerate(centroids, cut);
        expect(new Set(labels).size).toBe(source.length);
        source.forEach((_, i) => expect(labels[i]).toBe(labels[i + source.length]));
      });
    }

    it("collapses every corpus to one speaker at a threshold nothing exceeds", () => {
      for (const [name] of cuts) {
        const centroids = turnsOf(name).embeddings.map((e) => new Float32Array(e));
        expect(new Set(agglomerate(centroids, 2)).size).toBe(1);
      }
    });
  });
});

describe("applyLabels", () => {
  it("rewrites fragment ids into speaker ids", () => {
    const turns = [turn(0, 1000, 0), turn(1000, 2000, 1), turn(2000, 3000, 2)];
    applyLabels(turns, [0, 1, 0]);
    expect(turns.map((t) => t.speaker)).toEqual([0, 1, 0]);
  });

  it("gives an unembeddable fragment the nearest real speaker", () => {
    const turns = [turn(0, 4000, 0), turn(4100, 4300, 1), turn(9000, 12000, 2)];
    applyLabels(turns, [0, null, 1]);
    expect(turns.map((t) => t.speaker)).toEqual([0, 0, 1]);
  });

  it("resolves each unembeddable turn against a real speaker, never against another one", () => {
    // both middle turns are fragment 1, which embedded to nothing; they must anchor on the
    // real speakers either side rather than on each other
    const turns = [turn(0, 2000, 0), turn(2000, 2400, 1), turn(9000, 9400, 1), turn(10_000, 14_000, 2)];
    applyLabels(turns, [0, null, 1]);
    expect(turns.map((t) => t.speaker)).toEqual([0, 0, 1, 1]);
  });
});

describe("pruneTinySpeakers", () => {
  const long = (start: number, speaker: number): Turn =>
    turn(start, start + MIN_SPEAKER_MS + 1000, speaker);

  it("folds a below-floor speaker into whoever was nearest in time", () => {
    const turns = [long(0, 0), turn(20_000, 20_300, 2), long(40_000, 1)];
    pruneTinySpeakers(turns);
    expect(turns.map((t) => t.speaker)).toEqual([0, 0, 1]);
  });

  it("does nothing when every speaker clears the floor", () => {
    const turns = [long(0, 0), long(40_000, 1)];
    pruneTinySpeakers(turns);
    expect(turns.map((t) => t.speaker)).toEqual([0, 1]);
  });

  it("does nothing when none of them do", () => {
    // a uniformly quiet recording keeps its clusters rather than collapsing to one
    const turns = [turn(0, 500, 0), turn(1000, 1500, 1)];
    pruneTinySpeakers(turns);
    expect(turns.map((t) => t.speaker)).toEqual([0, 1]);
  });

  it("sums a speaker's turns before comparing to the floor", () => {
    const many = Array.from({ length: 30 }, (_, i) => turn(i * 1000, i * 1000 + 500, 1));
    const turns = [long(0, 0), ...many];
    pruneTinySpeakers(turns);
    expect(turns.every((t) => t.speaker === (t.end_ms - t.start_ms === 500 ? 1 : 0))).toBe(true);
  });
});

describe("renumber", () => {
  it("compacts ids by first appearance", () => {
    const turns = [turn(0, 1, 5), turn(1, 2, 2), turn(2, 3, 5), turn(3, 4, 9)];
    renumber(turns);
    expect(turns.map((t) => t.speaker)).toEqual([0, 1, 0, 2]);
  });
});

describe("isEmbedded", () => {
  it("is false for an all-zero centroid", () => {
    expect(isEmbedded(new Float32Array(8))).toBe(false);
    expect(isEmbedded(new Float32Array([0, 0, -0.1]))).toBe(true);
  });

  it("is false for a non-finite one", () => {
    // what the extractor returns for a clip under ~30 ms: no error, just garbage
    expect(isEmbedded(new Float32Array([0.1, NaN, 0.2]))).toBe(false);
    expect(isEmbedded(new Float32Array([0.1, Infinity, 0.2]))).toBe(false);
  });
});

describe("midpoint and nearest", () => {
  it("takes the midpoint of a turn, rounding down", () => {
    expect(midpoint(turn(0, 999, 0))).toBe(499);
  });

  it("picks the closest anchor and keeps the first on a tie", () => {
    expect(nearest([[0, 4], [200, 7]], 100)).toBe(4);
    expect(nearest([[0, 4], [150, 7]], 100)).toBe(7);
  });
});
