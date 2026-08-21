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
  display_name: string | null; // the person's name if linked, else a local rename; null = anonymous
  person_id: number | null; // global identity; null = named here only, or not named at all
}

/** A voice known across recordings. The voiceprint itself never crosses ipc. */
export interface Person {
  id: number;
  name: string;
  samples: number; // confirmed clusters behind the voiceprint; 0 = named but never matchable
  recordings: number; // recordings they currently appear in
  created_at: number; // unix seconds
  is_me: boolean; // at most one person in the library has this
  role: string | null; // free text; frames AI task generation, never filters it
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
  /** "overview" hits open the Overview tab; only "transcript" hits carry a real moment */
  kind: "transcript" | "overview";
  recording_id: number;
  filename: string;
  segment_id: number; // 0 on an overview hit
  start_ms: number; // 0 on an overview hit
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
  /** Remaining wall time for the whole job; null when there is nothing to estimate from. */
  eta_ms: number | null;
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

// Live resource meters. Polled by the renderer while the window is visible; there
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

// Phase 09 — AI overview. Everything here is a satellite of a recording: `Status` never
// enters an AI state, and an overview can be absent, running or failed while the transcript
// beside it is perfectly fine.

export type OverviewStatus = "pending" | "running" | "done" | "failed";

/** Why a call failed, so the ui can say whether "Retry" is even the right advice. */
export type ErrorKind = "auth" | "rate_limit" | "network" | "validation" | "aborted" | "unknown";

/**
 * One claim, anchored to the moment it was said. The model cites a segment id and never a
 * timestamp; `start_ms` is resolved here from that id (decision #28), which is why a bullet
 * can never point at a moment that does not exist.
 */
export interface OverviewBullet {
  text: string;
  segment_id: number;
  start_ms: number;
  /** unottr://frame/<recording>/<ms> — absent when the recording has no video (decision #30) */
  frame_url: string | null;
}

export interface OverviewSection {
  heading: string;
  start_ms: number; // span of the bullets it holds, so the section itself is seekable
  end_ms: number;
  bullets: OverviewBullet[];
}

export interface Overview {
  recording_id: number;
  status: OverviewStatus;
  error: string | null;
  error_kind: ErrorKind | null;
  model: string | null;
  role_used: string | null; // the role the tasks were written for, as it was at generation time
  title: string | null;
  tldr: string | null;
  sections: OverviewSection[];
  decisions: OverviewBullet[];
  tokens_in: number | null;
  tokens_out: number | null;
  updated_at: number;
  /** prompt has moved on, or your role has, since this was written — offer a regenerate */
  stale: boolean;
}

export type TaskStatus = "open" | "done" | "dismissed";

export interface Task {
  id: number;
  recording_id: number;
  text: string;
  owner_speaker_id: number | null;
  owner_name: string | null; // resolved display name; null = unattributed
  is_mine: boolean; // owner's speaker links to the `is_me` person
  start_ms: number;
  due_raw: string | null; // "by Friday", as spoken
  due_date: string | null; // YYYY-MM-DD, null when it did not resolve
  status: TaskStatus;
  user_edited: boolean;
}

/** What the Overview tab renders. `overview` is null before anything has ever been asked for. */
export interface OverviewPayload {
  overview: Overview | null;
  tasks: Task[];
}

export interface AiSettings {
  model: string;
  /** replace names with Speaker N before the transcript leaves the machine */
  pseudonymize: boolean;
  /** the one-time "this sends text to Mistral" acknowledgement (decision #34) */
  consented: boolean;
  key_set: boolean;
  /** "plain" = safeStorage had no keyring to talk to; the ui says so rather than pretending */
  key_storage: "encrypted" | "plain";
  /** running estimate in cents, so the number in settings is this library's, not a brochure's */
  spend_cents: number;
}

export interface OverviewChanged {
  recording_id: number;
}
