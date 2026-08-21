// The only place a citation is checked. Everything the model said arrives here as ids and
// leaves as milliseconds; nothing downstream of this file knows segment ids exist.
//
// The bias is uniform: when a citation cannot be verified, drop the claim. A summary with
// four bullets that all land is worth more than five where one points at the wrong minute.

import type { OverviewWrite } from "../db/overviews";
import type { OverviewOutput } from "./schema";

export interface GroundContext {
  /** segment id -> start_ms; membership is also what makes a citation legal */
  starts: Map<number, number>;
  speakerIds: Set<number>;
}

export type Grounded = Pick<OverviewWrite, "title" | "tldr" | "sections" | "decisions" | "tasks">;

export interface GroundResult extends Grounded {
  /** claims thrown away for citing an id that does not exist — logged, not shown */
  dropped: number;
}

export function ground(out: OverviewOutput, ctx: GroundContext): GroundResult {
  let dropped = 0;

  const cite = <T extends { text: string; segment_id: number }>(c: T) => {
    const start = ctx.starts.get(c.segment_id);
    const text = c.text.trim();
    if (start === undefined || !text) {
      dropped++;
      return null;
    }
    return { text, segment_id: c.segment_id, start_ms: start };
  };

  const sections = (out.sections ?? []).flatMap((s) => {
    const bullets = (s.bullets ?? []).map(cite).filter(isPresent);
    // a heading whose every bullet failed to ground has nothing left to say
    if (!bullets.length) return [];
    return [
      {
        heading: s.heading.trim(),
        start_ms: Math.min(...bullets.map((b) => b.start_ms)),
        end_ms: Math.max(...bullets.map((b) => b.start_ms)),
        bullets,
      },
    ];
  });

  const tasks = (out.tasks ?? []).flatMap((t) => {
    const start = ctx.starts.get(t.segment_id);
    const text = t.text.trim();
    if (start === undefined || !text) {
      dropped++;
      return [];
    }
    return [
      {
        text,
        ownerSpeakerId: ctx.speakerIds.has(t.owner_speaker_id) ? t.owner_speaker_id : null,
        startMs: start,
        dueRaw: t.due_raw?.trim() || null,
        // a deadline resolved wrongly is worse than one left as the words that were said
        dueDate: isDate(t.due_date) ? t.due_date : null,
      },
    ];
  });

  return {
    title: out.title.trim(),
    tldr: out.tldr.trim(),
    sections,
    decisions: (out.decisions ?? []).map(cite).filter(isPresent),
    tasks,
    dropped,
  };
}

const isPresent = <T>(v: T | null): v is T => v !== null;

/** Shape *and* reality: "2026-02-31" parses in some readings and is not a day. */
function isDate(raw: string | undefined): raw is string {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const d = new Date(`${raw}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === raw;
}
