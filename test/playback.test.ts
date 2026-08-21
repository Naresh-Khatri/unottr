import { describe, expect, it } from "vitest";
import { resumeOffer, speakerBands, stepRate } from "../src/renderer/src/lib/playback";

const seg = (speaker_id: number | null, start_ms: number, end_ms: number) =>
  ({ speaker_id, start_ms, end_ms });

describe("speakerBands", () => {
  it("collapses a run by one voice into a single band", () => {
    expect(speakerBands([seg(1, 0, 1000), seg(1, 1000, 2500), seg(2, 2500, 4000)])).toEqual([
      { sid: 1, start_ms: 0, end_ms: 2500 },
      { sid: 2, start_ms: 2500, end_ms: 4000 },
    ]);
  });

  it("breaks a run across a long silence", () => {
    expect(speakerBands([seg(1, 0, 1000), seg(1, 30_000, 31_000)])).toEqual([
      { sid: 1, start_ms: 0, end_ms: 1000 },
      { sid: 1, start_ms: 30_000, end_ms: 31_000 },
    ]);
  });

  it("keeps unattributed stretches as their own bands", () => {
    expect(speakerBands([seg(null, 0, 500), seg(1, 500, 900)]).map((b) => b.sid)).toEqual([null, 1]);
  });

  it("survives overlapping segments without going backwards", () => {
    expect(speakerBands([seg(1, 0, 4000), seg(1, 1000, 2000)])).toEqual([
      { sid: 1, start_ms: 0, end_ms: 4000 },
    ]);
  });
});

describe("resumeOffer", () => {
  it("ignores a position nobody would call progress", () => {
    expect(resumeOffer(null, 600_000)).toBeNull();
    expect(resumeOffer(4000, 600_000)).toBeNull();
  });

  it("ignores one at the end — that is a rewatch, not a resume", () => {
    expect(resumeOffer(595_000, 600_000)).toBeNull();
  });

  it("offers a real one, with or without a known duration", () => {
    expect(resumeOffer(120_000, 600_000)).toBe(120_000);
    expect(resumeOffer(120_000, null)).toBe(120_000);
  });
});

describe("stepRate", () => {
  it("clamps at the ends instead of wrapping", () => {
    expect(stepRate(0.5, -1)).toBe(0.5);
    expect(stepRate(2, 1)).toBe(2);
    expect(stepRate(1, 1)).toBe(1.25);
    expect(stepRate(1, -1)).toBe(0.75);
  });

  it("treats an off-menu rate as 1x", () => {
    expect(stepRate(3, 1)).toBe(1.25);
  });
});
