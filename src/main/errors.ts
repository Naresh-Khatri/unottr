// Port of crates/unottr-core/src/error.rs. One class, discriminated by `detail.kind` —
// the kind IS the slug the ui gets in `job_failed { error }`, so it must never be derived
// from the message.

export type ErrorDetail =
  | { kind: "io_error"; path: string; cause: string }
  | { kind: "db_error"; message: string }
  | { kind: "ffmpeg_missing" }
  | { kind: "ffmpeg_failed"; message: string }
  | { kind: "probe_failed"; path: string; reason: string }
  | { kind: "no_audio"; path: string }
  | { kind: "truncated"; path: string }
  | { kind: "whisper_failed"; message: string }
  | { kind: "gpu_oom" }
  | { kind: "diarize_failed"; message: string }
  | { kind: "model_missing"; name: string }
  | { kind: "download_failed"; name: string; reason: string }
  | { kind: "cancelled" };

export type Slug = ErrorDetail["kind"];

/** Whether/how a failed job gets retried. `bounded` parks after `max_attempts` total. */
export type RetryPolicy = "terminal" | "on_fix" | "bounded";

export class PipelineError extends Error {
  readonly detail: ErrorDetail;

  constructor(detail: ErrorDetail) {
    super(message(detail));
    this.name = "PipelineError";
    this.detail = detail;
  }

  get slug(): Slug {
    return this.detail.kind;
  }

  get retryPolicy(): RetryPolicy {
    switch (this.detail.kind) {
      // the file itself is the problem; no amount of retrying fixes it
      case "no_audio":
      case "truncated":
        return "terminal";
      // parked until the user installs ffmpeg or downloads the model, then "Retry" requeues
      case "ffmpeg_missing":
      case "model_missing":
        return "on_fix";
      // gpu_oom is handled by the queue (force cpu, retry once) before it reaches here
      default:
        return "bounded";
    }
  }
}

export const isCancelled = (e: unknown): boolean =>
  e instanceof PipelineError && e.detail.kind === "cancelled";

export const err = {
  io: (path: string, cause: unknown): PipelineError =>
    new PipelineError({ kind: "io_error", path, cause: reason(cause) }),
  db: (message: unknown): PipelineError =>
    new PipelineError({ kind: "db_error", message: reason(message) }),
  ffmpegMissing: (): PipelineError => new PipelineError({ kind: "ffmpeg_missing" }),
  ffmpeg: (message: string): PipelineError => new PipelineError({ kind: "ffmpeg_failed", message }),
  probe: (path: string, reason: string): PipelineError =>
    new PipelineError({ kind: "probe_failed", path, reason }),
  noAudio: (path: string): PipelineError => new PipelineError({ kind: "no_audio", path }),
  truncated: (path: string): PipelineError => new PipelineError({ kind: "truncated", path }),
  whisper: (message: string): PipelineError =>
    new PipelineError({ kind: "whisper_failed", message }),
  gpuOom: (): PipelineError => new PipelineError({ kind: "gpu_oom" }),
  diarize: (message: string): PipelineError =>
    new PipelineError({ kind: "diarize_failed", message }),
  modelMissing: (name: string): PipelineError => new PipelineError({ kind: "model_missing", name }),
  download: (name: string, reason: string): PipelineError =>
    new PipelineError({ kind: "download_failed", name, reason }),
  cancelled: (): PipelineError => new PipelineError({ kind: "cancelled" }),
};

/** Same wording as the rust `#[error(...)]` attributes — logs and fixtures compare against it. */
function message(d: ErrorDetail): string {
  switch (d.kind) {
    case "io_error":
      return `io error at ${d.path}: ${d.cause}`;
    case "db_error":
      return `database error: ${d.message}`;
    case "ffmpeg_missing":
      return "ffmpeg was not found";
    case "ffmpeg_failed":
      return `ffmpeg failed: ${d.message}`;
    case "probe_failed":
      return `could not probe ${d.path}: ${d.reason}`;
    case "no_audio":
      return `${d.path} has no audio track`;
    case "truncated":
      return `${d.path} is incomplete or corrupt`;
    case "whisper_failed":
      return `transcription failed: ${d.message}`;
    case "gpu_oom":
      return "gpu ran out of memory";
    case "diarize_failed":
      return `diarization failed: ${d.message}`;
    case "model_missing":
      return `model ${d.name} is not downloaded`;
    case "download_failed":
      return `could not download ${d.name}: ${d.reason}`;
    case "cancelled":
      return "cancelled";
  }
}

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));
