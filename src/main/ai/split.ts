// One meeting, more transcript than the model can hold. The alternative to splitting it is
// refusing, and an 8k local server against an hour of audio is the normal case here, not the
// edge one — so the transcript goes through in windows and the pieces are put back together.
//
// Citations survive this intact: every window carries the real segment ids, so a bullet from
// part 4 grounds exactly as a bullet from a single-pass answer does.

import type { PromptSegment } from "./prompt";
import type { OverviewOutput } from "./schema";

/** Enough of the last window to keep a thought that ran over the boundary readable. */
const OVERLAP = 2;

/** …but never so much of one that the windows stop making progress through the meeting. */
const OVERLAP_SHARE = 0.25;

/** Roughly what `[id] Name: ` costs on top of the words themselves. */
const LINE_OVERHEAD = 32;

/**
 * Windows that each fit `budgetChars`, in meeting order. A single segment larger than the
 * budget still goes out alone rather than being cut in half: a truncated line is a citation
 * pointing at words nobody said.
 */
export function windows(segments: PromptSegment[], budgetChars: number): PromptSegment[][] {
  if (budgetChars <= 0 || !segments.length) return [];

  const out: PromptSegment[][] = [];
  let current: PromptSegment[] = [];
  let size = 0;

  for (const s of segments) {
    const cost = s.text.length + LINE_OVERHEAD;
    if (current.length && size + cost > budgetChars) {
      out.push(current);
      current = tail(current, budgetChars * OVERLAP_SHARE);
      size = current.reduce((n, t) => n + t.text.length + LINE_OVERHEAD, 0);
    }
    current.push(s);
    size += cost;
  }
  if (current.length) out.push(current);
  return out;
}

/**
 * The parts, back into one overview. Sections keep the meeting's order because the windows
 * were in it; everything else is deduplicated by the segment it cites, which is what makes
 * the overlap above free — the same line summarized twice is one claim, not two.
 *
 * `title` and `tldr` are left empty on purpose: they are the only two fields that need to
 * have seen the whole meeting, and generate.ts asks for them separately.
 */
export function merge(parts: OverviewOutput[]): OverviewOutput {
  const seenBullet = new Set<number>();
  const sections = parts
    .flatMap((p) => p.sections ?? [])
    .flatMap((sec) => {
      const bullets = (sec.bullets ?? []).filter((b) => {
        if (seenBullet.has(b.segment_id)) return false;
        seenBullet.add(b.segment_id);
        return true;
      });
      return bullets.length ? [{ ...sec, bullets }] : [];
    });

  return {
    title: "",
    tldr: "",
    sections,
    decisions: once(parts.flatMap((p) => p.decisions ?? [])),
    tasks: once(parts.flatMap((p) => p.tasks ?? [])),
  };
}

/** The last few segments, as long as they are a small enough share of the next window. */
function tail(window: PromptSegment[], allowance: number): PromptSegment[] {
  const out: PromptSegment[] = [];
  let size = 0;
  for (const s of window.slice(-OVERLAP).reverse()) {
    size += s.text.length + LINE_OVERHEAD;
    if (size > allowance) break;
    out.unshift(s);
  }
  return out;
}

/** Same line, same item. Two models saying it twice does not make it two commitments. */
function once<T extends { segment_id: number }>(items: T[]): T[] {
  const seen = new Set<number>();
  return items.filter((i) => {
    if (seen.has(i.segment_id)) return false;
    seen.add(i.segment_id);
    return true;
  });
}
