// The clustering sherpa does not do. Port of the pure half of
// crates/unottr-core/src/diarize/engine.rs: relabelling, UPGMA over fragment centroids,
// pruning phantom speakers. No models, no I/O — this is the part worth testing.

import type { Turn } from "./types";

/**
 * Cosine distance at which two of sherpa's fragments stop being the same person, when the
 * speaker count is unknown. Smaller -> more speakers. This is our own average-linkage cut
 * over fragment centroids, not sherpa's.
 */
export const DEFAULT_THRESHOLD = 0.6;

/**
 * Threshold handed to sherpa itself. Deliberately tight: its complete-linkage merges only
 * when every turn-pair agrees, so a tight cut yields many *pure* fragments of each speaker
 * that our own average-linkage then rejoins. A single noisy turn can split a fragment but
 * never contaminate one.
 */
export const FRAGMENT_THRESHOLD = 0.5;

/**
 * A cluster with less total speech than this is a mis-embedded fragment -- a stray "yeah"
 * whose noisy centroid never merged -- not a person. Its turns fold into the nearest real
 * speaker. Tuned to the gap on the corpus: real speakers clear it by 2x+, phantoms sit
 * under 6 s. Only applied in threshold mode; fixed-k trusts the caller's count.
 */
export const MIN_SPEAKER_MS = 10_000;

/** One raw sherpa segment: seconds, plus whatever cluster id its clustering fell out with. */
export interface RawSegment {
  start: number;
  end: number;
  speaker: number;
}

/**
 * Sherpa numbers clusters however clustering happened to fall out. Renumber by first
 * appearance so "Speaker 1" is whoever opened the meeting, on every run.
 */
export function relabel(segments: RawSegment[]): Turn[] {
  const sorted = [...segments].sort((a, b) => a.start - b.start || a.end - b.end);
  const order: number[] = [];
  const turns: Turn[] = [];
  for (const s of sorted) {
    if (s.end <= s.start) continue;
    let speaker = order.indexOf(s.speaker);
    if (speaker < 0) speaker = order.push(s.speaker) - 1;
    // fround: sherpa hands back f32 seconds and rust did the *1000 in f32 too. in f64 the
    // product lands the other side of a whole ms often enough to shift a boundary by 1 ms.
    turns.push({
      start_ms: Math.trunc(Math.fround(Math.max(0, s.start) * 1000)),
      end_ms: Math.trunc(Math.fround(Math.max(0, s.end) * 1000)),
      speaker,
    });
  }
  return turns;
}

export const fragmentCount = (turns: Turn[]): number =>
  turns.reduce((n, t) => Math.max(n, t.speaker + 1), 0);

/**
 * Merge fragment centroids by average-linkage (UPGMA) until the closest two groups are
 * farther apart than `threshold` in cosine distance. Returns a speaker id per input
 * centroid. Average-linkage, unlike sherpa's complete-linkage, tolerates a single noisy
 * turn: one bad pair cannot hold two of a speaker's fragments apart.
 */
export function agglomerate(centroids: Float32Array[], threshold: number): number[] {
  const n = centroids.length;
  // unit vectors -> cosine distance is 1 - dot
  const dist = (a: number, b: number): number => {
    const x = centroids[a];
    const y = centroids[b];
    let dot = 0;
    for (let i = 0; i < Math.min(x.length, y.length); i++) dot += x[i] * y[i];
    return 1 - dot;
  };

  const members: number[][] = Array.from({ length: n }, (_, i) => [i]);
  const alive: boolean[] = Array.from({ length: n }, () => true);
  for (;;) {
    const live: number[] = [];
    for (let i = 0; i < n; i++) if (alive[i]) live.push(i);

    let bestAvg = threshold;
    let bestA = -1;
    let bestB = -1;
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i];
        const b = live[j];
        let sum = 0;
        for (const x of members[a]) for (const y of members[b]) sum += dist(x, y);
        const avg = sum / (members[a].length * members[b].length);
        if (avg < bestAvg) {
          bestAvg = avg;
          bestA = a;
          bestB = b;
        }
      }
    }
    if (bestA < 0) break;
    members[bestA].push(...members[bestB]);
    members[bestB] = [];
    alive[bestB] = false;
  }

  const speaker = new Array<number>(n).fill(0);
  let id = 0;
  for (let g = 0; g < n; g++) {
    if (!alive[g]) continue;
    for (const m of members[g]) speaker[m] = id;
    id++;
  }
  return speaker;
}

/**
 * Rewrite fragment ids into speaker ids. `speakerOf[fragment]` is null when that fragment
 * embedded to nothing; those turns borrow the label of the real speaker nearest in time — a
 * lone "yeah" should not become its own speaker.
 */
export function applyLabels(turns: Turn[], speakerOf: (number | null)[]): void {
  // built before the rewrite, while turn.speaker is still a fragment id
  const anchors: [number, number][] = [];
  for (const t of turns) {
    const s = speakerOf[t.speaker];
    if (s !== null && s !== undefined) anchors.push([midpoint(t), s]);
  }
  for (const t of turns) {
    const s = speakerOf[t.speaker];
    t.speaker = s ?? nearest(anchors, midpoint(t));
  }
}

/**
 * Reassign every turn of a below-floor speaker to the real speaker nearest in time. A
 * backchannel "yeah" belongs to whoever was holding the floor around it. No-op when every
 * speaker clears the floor, or none does (a uniformly quiet recording keeps its clusters).
 */
export function pruneTinySpeakers(turns: Turn[]): void {
  const n = fragmentCount(turns);
  const speech = new Array<number>(n).fill(0);
  for (const t of turns) speech[t.speaker] += t.end_ms - t.start_ms;

  const kept = speech.map((d) => d >= MIN_SPEAKER_MS);
  if (!kept.some(Boolean) || kept.every(Boolean)) return;

  const anchors: [number, number][] = turns
    .filter((t) => kept[t.speaker])
    .map((t) => [midpoint(t), t.speaker]);
  for (const t of turns) {
    if (!kept[t.speaker]) t.speaker = nearest(anchors, midpoint(t));
  }
}

/**
 * Renumber speakers by first appearance so "Speaker 1" opens the meeting on every run.
 * Turns are already in start order.
 */
export function renumber(turns: Turn[]): void {
  const order: number[] = [];
  for (const t of turns) {
    let i = order.indexOf(t.speaker);
    if (i < 0) i = order.push(t.speaker) - 1;
    t.speaker = i;
  }
}

/** A centroid is all-zero only when every turn feeding it was too short to embed. */
/** A fragment too short to embed comes back all zeros, and one under ~30 ms comes back
 *  non-finite; neither can be clustered, so both count as unembedded. */
export const isEmbedded = (centroid: Float32Array): boolean =>
  centroid.some((x) => x !== 0) && centroid.every(Number.isFinite);

/**
 * Cosine similarity is the only thing these vectors are ever compared with, so store them
 * unit length and let the comparison be a dot product.
 */
export function normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  // f32::EPSILON, matching the rust guard
  if (norm > 1.1920929e-7) for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

export const midpoint = (t: Turn): number => t.start_ms + Math.trunc((t.end_ms - t.start_ms) / 2);

/** Speaker of the anchor nearest `mid` in time. `anchors` is never empty at the call site. */
export function nearest(anchors: [number, number][], mid: number): number {
  let best = 0;
  let bestGap = Infinity;
  for (const [m, s] of anchors) {
    const gap = Math.abs(m - mid);
    if (gap < bestGap) {
      bestGap = gap;
      best = s;
    }
  }
  return best;
}
