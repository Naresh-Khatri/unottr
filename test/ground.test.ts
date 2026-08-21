// Grounding is the one thing standing between a confident-sounding model and a link into the
// wrong minute of the video. Canned output in, checked claims out — no model involved.

import { describe, expect, it } from "vitest";
import { ground } from "../src/main/ai/ground";
import type { OverviewOutput } from "../src/main/ai/schema";

const ctx = {
  starts: new Map([
    [1, 1000],
    [2, 5000],
    [3, 9000],
  ]),
  speakerIds: new Set([70, 71]),
};

const output = (over: Partial<OverviewOutput> = {}): OverviewOutput => ({
  title: "Roadmap review",
  tldr: "They cut the reranker.",
  sections: [],
  decisions: [],
  tasks: [],
  ...over,
});

describe("ground", () => {
  it("drops a bullet citing a segment that does not exist", () => {
    const r = ground(
      output({
        sections: [
          {
            heading: "Latency",
            bullets: [
              { text: "real", segment_id: 2 },
              { text: "invented", segment_id: 999 },
            ],
          },
        ],
      }),
      ctx,
    );

    expect(r.sections[0].bullets.map((b) => b.text)).toEqual(["real"]);
    expect(r.dropped).toBe(1);
  });

  it("removes a section whose every bullet was dropped", () => {
    const r = ground(
      output({
        sections: [
          { heading: "Real", bullets: [{ text: "kept", segment_id: 1 }] },
          { heading: "Hallucinated", bullets: [{ text: "gone", segment_id: 404 }] },
        ],
      }),
      ctx,
    );

    expect(r.sections.map((s) => s.heading)).toEqual(["Real"]);
  });

  it("spans a section across the bullets it kept", () => {
    const r = ground(
      output({
        sections: [
          {
            heading: "Latency",
            bullets: [
              { text: "a", segment_id: 1 },
              { text: "b", segment_id: 3 },
            ],
          },
        ],
      }),
      ctx,
    );

    expect(r.sections[0]).toMatchObject({ start_ms: 1000, end_ms: 9000 });
  });

  it("resolves ids to milliseconds, never trusting a timestamp from the model", () => {
    const r = ground(output({ decisions: [{ text: "cut it", segment_id: 3 }] }), ctx);
    expect(r.decisions).toEqual([{ text: "cut it", segment_id: 3, start_ms: 9000 }]);
  });

  it("nulls an owner who was not in the roster", () => {
    const r = ground(
      output({
        tasks: [
          { text: "mine", owner_speaker_id: 71, segment_id: 1, due_raw: "", due_date: "" },
          { text: "nobody's", owner_speaker_id: 88, segment_id: 1, due_raw: "", due_date: "" },
        ],
      }),
      ctx,
    );

    expect(r.tasks.map((t) => t.ownerSpeakerId)).toEqual([71, null]);
  });

  it("keeps the spoken phrase when the date does not parse", () => {
    const r = ground(
      output({
        tasks: [
          { text: "ship it", owner_speaker_id: 70, segment_id: 2, due_raw: "next quarter", due_date: "sometime" },
          { text: "file it", owner_speaker_id: 70, segment_id: 2, due_raw: "end of Feb", due_date: "2026-02-31" },
          { text: "send it", owner_speaker_id: 70, segment_id: 2, due_raw: "by Friday", due_date: "2026-08-21" },
        ],
      }),
      ctx,
    );

    expect(r.tasks.map((t) => [t.dueRaw, t.dueDate])).toEqual([
      ["next quarter", null],
      ["end of Feb", null], // shape is right, the day is not real
      ["by Friday", "2026-08-21"],
    ]);
  });

  it("drops a task citing an unknown segment", () => {
    const r = ground(
      output({
        tasks: [{ text: "phantom", owner_speaker_id: 70, segment_id: 12, due_raw: "", due_date: "" }],
      }),
      ctx,
    );

    expect(r.tasks).toEqual([]);
    expect(r.dropped).toBe(1);
  });
});
