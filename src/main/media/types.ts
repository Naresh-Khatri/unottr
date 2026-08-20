// Shapes shared by ffmpeg.ts, track.ts and pcm.ts. Field names are the rust serde ones so
// a dumped `probe.json` compares byte for byte.

/** Sample rate whisper.cpp expects. Everything downstream assumes mono s16le at this rate. */
export const TARGET_SAMPLE_RATE = 16_000;

export interface AudioStream {
  /** Global stream index, for display. */
  index: number;
  /** Position among audio streams; this is what `-map 0:a:N` takes. */
  audio_index: number;
  codec: string;
  channels: number;
  sample_rate: number;
  title: string | null;
  language: string | null;
}

export interface Probe {
  container: string;
  duration_ms: number | null;
  has_video: boolean;
  audio: AudioStream[];
}

export const streamOf = (p: Probe, audioIndex: number): AudioStream | undefined =>
  p.audio.find((s) => s.audio_index === audioIndex);
