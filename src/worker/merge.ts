// Attaching speakers to transcript segments. Port of crates/unottr-core/src/diarize/merge.rs.
// Whisper and the diarizer disagree about where anything starts, so this is overlap
// arithmetic, not a join. Nothing here loads a model — that is deliberate, it is the part
// worth testing.

import type { Turn } from "./types";
import type { Word } from "./whisper";

/** Two overlaps this close are a coin flip, so we look for a boundary instead of picking. */
const TIE = 0.2;

/** 3 -> 8 pieces. More speaker changes than that inside one whisper segment means the turns
 *  are noise, not dialogue. */
const MAX_DEPTH = 3;

/** A transcript row as phase 02 left it. */
export interface Segment {
  id: number;
  chunk_idx: number;
  start_ms: number;
  end_ms: number;
  text: string;
  words: Word[];
}

/** One segment's worth of speech after attribution. Usually a single piece; more when a
 *  speaker changed mid-segment. */
export interface Piece {
  start_ms: number;
  end_ms: number;
  text: string;
  words: Word[];
  /** null = no turn overlapped at all. Rendered unattributed; we do not guess. */
  speaker: number | null;
}

export interface Assigned {
  /** The `segments` row this came from. */
  id: number;
  chunk_idx: number;
  pieces: Piece[];
}

export const isSplit = (a: Assigned): boolean => a.pieces.length > 1;

export function assign(segments: Segment[], turns: Turn[]): Assigned[] {
  return segments.map((s) => assignOne(s, turns));
}

/** A half-open slice of a segment's words plus who said it. */
interface Cut {
  lo: number;
  hi: number;
  start_ms: number;
  end_ms: number;
  speaker: number | null;
}

function assignOne(seg: Segment, turns: Turn[]): Assigned {
  const raw: Cut[] = [];
  resolve(seg.start_ms, seg.end_ms, seg.words, 0, turns, 0, raw);
  const cuts = coalesce(raw);

  return {
    id: seg.id,
    chunk_idx: seg.chunk_idx,
    pieces: cuts.map((cut) => ({
      start_ms: cut.start_ms,
      end_ms: cut.end_ms,
      // an unsplit segment keeps whisper's own text; only halves get rebuilt, where joining
      // on spaces is right because `Word.text` is already space-stripped
      text: cuts.length === 1 ? seg.text : join(seg.words.slice(cut.lo, cut.hi)),
      words: seg.words.slice(cut.lo, cut.hi),
      speaker: cut.speaker,
    })),
  };
}

function resolve(
  startMs: number,
  endMs: number,
  words: Word[],
  base: number,
  turns: Turn[],
  depth: number,
  out: Cut[],
): void {
  const ranked = rank(startMs, endMs, turns);
  const lo = base;
  const hi = base + words.length;

  if (ranked.length === 0) {
    out.push({ lo, hi, start_ms: startMs, end_ms: endMs, speaker: null });
    return;
  }

  const [top, best] = ranked[0];
  const second = ranked[1];
  let k: number | null = null;
  if (depth < MAX_DEPTH && words.length >= 2 && second && tied(best, second[1])) {
    const boundary = crossover(startMs, endMs, turns, top, second[0]);
    if (boundary !== null) k = snap(words, boundary);
  }

  if (k === null) {
    out.push({ lo, hi, start_ms: startMs, end_ms: endMs, speaker: top });
    return;
  }

  resolve(startMs, words[k - 1].end_ms, words.slice(0, k), base, turns, depth + 1, out);
  resolve(words[k].start_ms, endMs, words.slice(k), base + k, turns, depth + 1, out);
}

/**
 * Speakers by how much of `[startMs, endMs)` they hold, most first. Summed per *speaker*
 * rather than per turn: two short turns by one person should beat one long turn by another.
 */
function rank(startMs: number, endMs: number, turns: Turn[]): [number, number][] {
  const totals = new Map<number, number>();
  for (const turn of turns) {
    const hit = overlap(startMs, endMs, turn.start_ms, turn.end_ms);
    if (hit > 0) totals.set(turn.speaker, (totals.get(turn.speaker) ?? 0) + hit);
  }
  // speaker id breaks ties so the same input always assigns the same way
  return [...totals].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
}

export const overlap = (a0: number, a1: number, b0: number, b1: number): number =>
  Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

export const tied = (best: number, second: number): boolean =>
  best > 0 && (best - second) / best <= TIE;

/**
 * Where `a` most plausibly hands over to `b`. Candidates are turn edges strictly inside the
 * segment; the winner is the one that leaves the most speech on the correct side of it.
 */
function crossover(
  startMs: number,
  endMs: number,
  turns: Turn[],
  a: number,
  b: number,
): number | null {
  const edges = [
    ...new Set(
      turns
        .filter((t) => overlap(startMs, endMs, t.start_ms, t.end_ms) > 0)
        .flatMap((t) => [t.start_ms, t.end_ms])
        .filter((e) => e > startMs && e < endMs),
    ),
  ].sort((x, y) => x - y);

  const held = (lo: number, hi: number, who: number): number =>
    turns
      .filter((t) => t.speaker === who)
      .reduce((sum, t) => sum + overlap(lo, hi, t.start_ms, t.end_ms), 0);

  let bestEdge: number | null = null;
  let bestScore = -1;
  for (const e of edges) {
    const forward = held(startMs, e, a) + held(e, endMs, b);
    const reverse = held(startMs, e, b) + held(e, endMs, a);
    const score = Math.max(forward, reverse);
    // strictly greater keeps the earliest edge among equals, matching the rust tiebreak
    if (score > bestScore) {
      bestScore = score;
      bestEdge = e;
    }
  }
  return bestEdge;
}

/**
 * Nearest word start to `boundary`, as an index into `words`. Never 0 and never
 * `words.length`, so both halves keep at least one word — the split can only land on a word
 * boundary, which is the whole point.
 */
function snap(words: Word[], boundary: number): number {
  let best = 1;
  let bestGap = Math.abs(words[1].start_ms - boundary);
  for (let k = 2; k < words.length; k++) {
    const gap = Math.abs(words[k].start_ms - boundary);
    if (gap < bestGap) {
      bestGap = gap;
      best = k;
    }
  }
  return best;
}

/** Halves resolved independently can land on the same speaker; that split bought nothing. */
function coalesce(cuts: Cut[]): Cut[] {
  const out: Cut[] = [];
  for (const cut of cuts) {
    const prev = out[out.length - 1];
    if (prev && prev.speaker === cut.speaker) {
      prev.hi = cut.hi;
      prev.end_ms = cut.end_ms;
    } else {
      out.push({ ...cut });
    }
  }
  return out;
}

const join = (words: Word[]): string => words.map((w) => w.text).join(" ");
