// The two-track shortcut. Port of crates/unottr-core/src/diarize/mic.rs. When phase 01
// identified a mic track, the local user is not a clustering problem: everything on that
// track is them. Speech detection is enough, and it is both faster and more reliable than
// asking an embedder to tell one voice from another through Meet's noise suppression.

import type { Span } from "./chunk";
import type { Diarization, Turn } from "./types";
import { detectSpeech } from "./vad";

/** The local user always takes id 0 in the merged label space. */
export const YOU = 0;
export const YOU_LABEL = "You";

/** Pauses shorter than this are inside a sentence, not between turns. */
const MERGE_GAP_MS = 800;

/** A cough or a keystroke trips the vad; a turn does not last 300 ms. */
const MIN_TURN_MS = 400;

/** Speech on the mic track, as turns belonging to {@link YOU}. */
export async function detect(micPcm: Buffer, vadModel: string): Promise<Turn[]> {
  return turnsFrom(await detectSpeech(micPcm, vadModel));
}

export function turnsFrom(spans: Span[]): Turn[] {
  const out: Turn[] = [];
  for (const span of spans) {
    const prev = out[out.length - 1];
    if (prev && Math.max(0, span.start_ms - prev.end_ms) <= MERGE_GAP_MS) {
      prev.end_ms = Math.max(prev.end_ms, span.end_ms);
    } else {
      out.push({ start_ms: span.start_ms, end_ms: span.end_ms, speaker: YOU });
    }
  }
  return out.filter((t) => t.end_ms - t.start_ms >= MIN_TURN_MS);
}

/**
 * Fold the desktop track's speakers in above the local user. Ids shift by one, so the
 * merged space reads 0 = You, 1..N = the people on the call.
 */
export function combine(
  you: Turn[],
  youEmbedding: Float32Array,
  desktop: Diarization,
): Diarization {
  const turns = [...you, ...desktop.turns.map((t) => ({ ...t, speaker: t.speaker + 1 }))];
  turns.sort(
    (a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms || a.speaker - b.speaker,
  );
  return { turns, embeddings: [youEmbedding, ...desktop.embeddings] };
}

/** `Speaker 1` is the first remote voice; the local user is never numbered. */
export const label = (speaker: number): string =>
  speaker === YOU ? YOU_LABEL : `Speaker ${speaker}`;
