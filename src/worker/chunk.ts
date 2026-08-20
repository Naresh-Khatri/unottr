// Port of crates/unottr-core/src/transcribe/chunk.rs. Pure arithmetic — no model, no io,
// so the packing rules stay testable against fixtures/*/chunks.json.

import { TARGET_SAMPLE_RATE } from "../main/media/types";

/** Whisper's encoder window. A longer chunk gets truncated inside whisper.cpp. */
export const MAX_CHUNK_MS = 30_000;

/**
 * Silence longer than this ends a chunk even when there is room left. Keeps dead air out of
 * what whisper hears, which is the mitigation for hallucinated filler.
 */
export const MAX_GAP_MS = 2_000;

/** A run of speech as the vad sees it. */
export interface Span {
  start_ms: number;
  end_ms: number;
}

/** One unit of transcription and one db transaction; `idx` lands in `segments.chunk_idx`. */
export interface Chunk {
  idx: number;
  start_ms: number;
  end_ms: number;
}

export const durationMs = (c: Chunk): number => c.end_ms - c.start_ms;

/** Sample range into the whole-file pcm buffer, clamped to what we actually have. */
export function range(c: Chunk, totalSamples: number): { lo: number; hi: number } {
  const lo = Math.min(samplesAt(c.start_ms), totalSamples);
  return { lo, hi: Math.max(lo, Math.min(samplesAt(c.end_ms), totalSamples)) };
}

const samplesAt = (ms: number): number => Math.floor((ms * TARGET_SAMPLE_RATE) / 1000);

/**
 * Greedily merge speech spans into chunks. Deterministic, so a resumed run reproduces
 * identical boundaries and `last_chunk_idx` still means what it meant.
 */
export function pack(spans: Span[], maxMs = MAX_CHUNK_MS, maxGapMs = MAX_GAP_MS): Chunk[] {
  const chunks: Chunk[] = [];
  let open: Chunk | undefined;

  for (const span of spans) {
    // vad shouldn't emit these, but a hard split keeps the invariant either way
    for (const piece of split(span, maxMs)) {
      if (!open) {
        open = { idx: 0, start_ms: piece.start_ms, end_ms: piece.end_ms };
      } else if (
        Math.max(0, piece.start_ms - open.end_ms) <= maxGapMs &&
        piece.end_ms - open.start_ms <= maxMs
      ) {
        open = { ...open, end_ms: piece.end_ms };
      } else {
        chunks.push(open);
        open = { idx: chunks.length, start_ms: piece.start_ms, end_ms: piece.end_ms };
      }
    }
  }

  if (open) chunks.push(open);
  return chunks;
}

function split(span: Span, maxMs: number): Span[] {
  const out: Span[] = [];
  let start = span.start_ms;
  while (span.end_ms - start > maxMs) {
    out.push({ start_ms: start, end_ms: start + maxMs });
    start += maxMs;
  }
  out.push({ start_ms: start, end_ms: span.end_ms });
  return out;
}
