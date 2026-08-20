// Shared diarization shapes. Kept out of diarize.ts so the pure modules (merge, cluster,
// mic) and their tests never pull the sherpa addon in.

/** One continuous stretch of one voice. `speaker` is a 0-based index into `embeddings`. */
export interface Turn {
  start_ms: number;
  end_ms: number;
  speaker: number;
}

export interface Diarization {
  turns: Turn[];
  /** One unit-length centroid per speaker; the index is the speaker id. */
  embeddings: Float32Array[];
}

export const speakerCount = (d: Diarization): number => d.embeddings.length;
