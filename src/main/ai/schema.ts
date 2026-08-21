// The shape the model must answer in, enforced server-side by Mistral's json_schema mode
// (decision #32) and re-checked here. Every "absent" is an empty string rather than null:
// strict json-schema modes are happiest with one type per field, and ground.ts is where an
// empty string becomes a real null anyway.

import { z } from "zod";

/** A claim plus the segment that carries it. Segment ids are checked in ground.ts. */
const cite = z.object({
  text: z.string().describe("one sentence, no leading bullet character"),
  segment_id: z.number().int().describe("id of the transcript line this comes from, copied exactly"),
});

export const overviewSchema = z.object({
  title: z.string().describe("6 words or fewer naming what this meeting was about"),
  tldr: z.string().describe("2-3 sentences a person who missed the meeting could read instead"),
  sections: z
    .array(
      z.object({
        heading: z.string().describe("3-6 words"),
        bullets: z.array(cite),
      }),
    )
    .describe("3-6 sections following the meeting's own order"),
  decisions: z.array(cite).describe("things settled, not things discussed; empty if nothing was"),
  tasks: z.array(
    z.object({
      text: z.string().describe("imperative, names the deliverable: 'Ship the export dialog'"),
      owner_speaker_id: z.number().int().describe("a speaker_id from the roster, or 0 if nobody took it"),
      segment_id: z.number().int().describe("the line where it was assigned"),
      due_raw: z.string().describe("the deadline as spoken, e.g. 'by Friday'; empty if none"),
      due_date: z.string().describe("that deadline as YYYY-MM-DD if it is unambiguous, else empty"),
    }),
  ),
});

export type OverviewOutput = z.infer<typeof overviewSchema>;

/** The whole-meeting half of the schema, asked for on its own when the transcript was split. */
export const overviewHeadSchema = overviewSchema.pick({ title: true, tldr: true });

/**
 * One filled-in answer, for the rungs where the request cannot carry a schema. A small local
 * model reads an example far better than it reads a JSON Schema — the schema says what is
 * legal, this says what is wanted.
 */
export const overviewExample: OverviewOutput = {
  title: "Pricing page rewrite",
  tldr: "The team agreed to rewrite the pricing page around three tiers and drop the annual toggle. Priya owns the copy, Sam the layout.",
  sections: [
    {
      heading: "Tier structure",
      bullets: [{ text: "Three tiers replace the current five.", segment_id: 12 }],
    },
  ],
  decisions: [{ text: "The annual/monthly toggle is removed.", segment_id: 31 }],
  tasks: [
    {
      text: "Draft the copy for all three tiers",
      owner_speaker_id: 2,
      segment_id: 34,
      due_raw: "by Friday",
      due_date: "2026-03-06",
    },
  ],
};
