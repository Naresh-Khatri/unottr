// Frozen IPC contract — mirrors docs/plan/05-ipc-contract.md.
// snake_case matches the wire (serde default); don't remap.

export type Status =
  | "discovered"
  | "probing"
  | "extracting"
  | "transcribing"
  | "diarizing"
  | "merging"
  | "done"
  | "failed";

export const IN_FLIGHT: Status[] = [
  "discovered",
  "probing",
  "extracting",
  "transcribing",
  "diarizing",
  "merging",
];

export interface Word {
  text: string;
  start_ms: number;
  end_ms: number;
  p: number | null; // mean token prob; null = unknown (see 08.4 deviation)
}

export interface Segment {
  id: number;
  chunk_idx: number;
  start_ms: number;
  end_ms: number;
  text: string;
  words: Word[];
  speaker_id: number | null; // null -> render unattributed, don't guess
  split_of: number | null; // set when diarization split a whisper row
}

export interface Speaker {
  id: number;
  recording_id: number;
  label: string; // "Speaker 1"
  display_name: string | null; // user rename; embedding never crosses ipc
}

export interface RecordingSummary {
  id: number;
  path: string;
  filename: string;
  recorded_at: number | null; // unix seconds
  duration_ms: number | null;
  status: Status;
  stage_detail: string | null;
  error: string | null; // typed-error slug when status=failed
  speaker_count: number;
  available: boolean; // false -> text usable, player disabled
  has_video: boolean;
}

export interface Recording extends RecordingSummary {
  container: string | null;
}

export interface RecordingDetail {
  recording: Recording;
  segments: Segment[];
  speakers: Speaker[];
}

export interface SearchHit {
  recording_id: number;
  filename: string;
  segment_id: number;
  start_ms: number;
  snippet: string; // fts snippet(), <b>-marked
}

export interface WatchFolder {
  id: number;
  path: string;
  track_rule: "auto" | string;
  enabled: boolean;
}

export interface RecordingFilter {
  status?: Status;
  available?: boolean;
  query?: string;
}

export interface RecordingSort {
  by: "recorded_at" | "duration_ms" | "filename";
  dir: "asc" | "desc";
}

// Rust -> UI events. pct is 0..1.
export interface JobProgress {
  recording_id: number;
  stage: Status;
  pct: number;
}
export interface JobDone {
  recording_id: number;
}
export interface JobFailed {
  recording_id: number;
  error: string;
}
export interface RecordingDiscovered {
  recording_id: number;
}

// Phase 06 — settings & shell additions.

export type Device = "auto" | "gpu" | "cpu";
export type Resolved = "gpu" | "cpu"; // what device:"auto" actually resolves to

export interface Settings {
  model_tier: string; // "auto" | "turbo" | "medium" | "small"
  language: string | null; // null -> auto-detect
  device: Device;
  diarize_threshold: number | null;
  ffmpeg_path: string | null;
  ffprobe_path: string | null;
  cache_dir: string | null;
  autostart: boolean;
  close_to_tray: boolean;
  tray_available: boolean; // runtime fact, not a persisted setting
  first_run_complete: boolean; // ui-only, gates first-run wizard
  ffmpeg_ok: boolean; // runtime fact, re-checked on every get/set_settings call
}

export interface ModelInfo {
  tier: "turbo" | "medium" | "small";
  name: string;
  size: number; // bytes
  downloaded: boolean;
}

export interface DiskUsage {
  models_bytes: number;
  cache_bytes: number;
}

export interface BackfillEstimate {
  folder: string;
  count: number;
  total_duration_ms: number;
  estimated_processing_ms: number;
}

export type ExportFormat = "txt" | "json" | "srt" | "vtt";

export interface ModelDownloadProgress {
  model: string; // tier name, not registry filename
  pct: number; // 0..1
}

// Phase 09 — live resource meters. Polled by the renderer while the window is visible; there
// is no event for these because the ui decides its own cadence.

export interface CpuStats {
  usage: number; // 0..1 across every logical core
  cores: number[]; // 0..1, one per logical core
  load1: number; // 1-minute load average
  mem_used: number; // bytes
  mem_total: number;
  temp_c: number | null;
  /** package power, null where rapl is absent or root-only. */
  watts: number | null;
}

export interface GpuStats {
  name: string;
  /** null when the driver publishes no busy counter — the card is still shown, without a bar. */
  usage: number | null; // 0..1
  vram_used: number | null; // bytes
  vram_total: number | null;
  temp_c: number | null;
  watts: number | null;
}

export interface SystemStats {
  cpu: CpuStats;
  gpu: GpuStats | null; // null = no gpu found at all
  device: Resolved; // what a job started right now would run on
  jobs_active: number; // 0 or 1 — queue concurrency is 1
  jobs_queued: number; // waiting, not counting the one in flight
}
