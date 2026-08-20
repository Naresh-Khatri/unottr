// Frontend mirror of the failure taxonomy table (07-hardening-and-packaging.md #1), keyed
// by the typed-error slug the backend stores in `recordings.error` (see error.rs::slug).
export type ErrorAction = "settings" | "retry" | "none";

export interface ErrorInfo {
  message: string;
  action: ErrorAction;
}

const TAXONOMY: Record<string, ErrorInfo> = {
  ffmpeg_missing: { message: "ffmpeg is required and was not found", action: "settings" },
  no_audio: { message: "This file has no audio track", action: "none" },
  truncated: {
    message: "Recording is incomplete or corrupt (often a crashed recorder)",
    action: "none",
  },
  model_missing: { message: "Model not downloaded", action: "settings" },
  // GpuOom is normally invisible (auto-retried on cpu before it ever reaches a `failed` row);
  // this only shows if that retry itself failed.
  gpu_oom: { message: "Ran out of GPU memory", action: "retry" },
  whisper_failed: { message: "Transcription failed", action: "retry" },
  diarize_failed: { message: "Transcription failed", action: "retry" },
  io_error: { message: "Cannot read the file — moved or permissions", action: "retry" },
};

// Slugs outside the spec's table (probe_failed, ffmpeg_failed, db_error, ...) get the same
// treatment as the Whisper/Diarize/Io row rather than showing a raw slug to the user.
const FALLBACK: ErrorInfo = { message: "Something went wrong", action: "retry" };

export function errorInfo(slug: string | null): ErrorInfo {
  if (!slug) return FALLBACK;
  return TAXONOMY[slug] ?? FALLBACK;
}
