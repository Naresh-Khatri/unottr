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
  /** user title, else the AI one; null -> fall back to `filename` (decision #32) */
  title: string | null;
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
  title: string | null; // same precedence as RecordingSummary.title
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

// main -> renderer events. pct is 0..1.
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

/**
 * Everything a job needs besides the whisper tier — vad, segmentation, speaker embedding.
 * No tier to choose between, so the ui treats the set as one thing.
 */
export interface SupportModels {
  ready: boolean;
  /** Bytes still to fetch; 0 once ready. */
  missing_bytes: number;
}

/** `ModelDownloadProgress.model` for the support set, which has no tier of its own. */
export const SUPPORT_MODELS = "support";

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
  model: string; // tier name, or SUPPORT_MODELS — never a registry filename
  /** 0..1. Reaches 1 only once the file is verified and renamed into place, never mid-stream. */
  pct: number;
  /** Set when the download stopped early — `cancelled`, or a download_failed reason. Terminal. */
  error?: string;
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
export type ErrorKind =
  | "auth"
  | "rate_limit"
  | "network"
  | "validation"
  | "aborted"
  /** nobody cancelled it — the model was slower than the time it was given */
  | "timeout"
  /** the endpoint itself never answered — a local server that isn't running, usually */
  | "unreachable"
  /** the transcript did not fit, and could not be split small enough to */
  | "too_long"
  | "unknown";

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
  /** the connection's label at generation time — "qwen3:8b" alone doesn't say who served it */
  provider: string | null;
  role_used: string | null; // the role the tasks were written for, as it was at generation time
  title: string | null;
  tldr: string | null;
  sections: OverviewSection[];
  decisions: OverviewBullet[];
  tokens_in: number | null;
  tokens_out: number | null;
  updated_at: number;
  /** the prompt, your role or the cast has moved on since this was written — offer a regenerate */
  stale: boolean;
  /** which of the three, so the nudge can name it; null when it is not stale */
  stale_reason: "speakers" | "role" | "prompt" | null;
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

// Phase 10 — bring-your-own model. Every endpoint is a row the user added; nothing is
// hardcoded to one vendor, and a key never crosses this boundary in either direction.

/** Request shape. Comes from the preset, never sniffed: a url can't tell you its own dialect. */
export type Wire = "openai" | "anthropic" | "mistral";

/** How the model is made to emit our schema, cheapest-first. Probed, not assumed. */
export type Strategy = "native" | "json_mode" | "prompted";

/**
 * The four rungs of a setup test, in order. A key check alone is worthless for a local model —
 * it will happily accept any key, answer "hi", and then fail every structured generation.
 */
export type ProbeStep = "reachable" | "authorized" | "responds" | "structured";

export interface ProbeRung {
  step: ProbeStep;
  ok: boolean;
  /** what went wrong, or the useful detail when it went right ("14 models", "1.2 s") */
  detail: string | null;
}

export interface ProbeResult {
  ok: boolean;
  rungs: ProbeRung[];
  /** the best rung that worked; null when it never got that far */
  strategy: Strategy | null;
  models: string[];
  /** the model the test actually ran against — chosen for the user when they had not picked one */
  model: string | null;
}

export interface AiConnection {
  id: number;
  label: string;
  preset: string; // a PRESETS id, or "custom"
  wire: Wire;
  base_url: string;
  key_set: boolean;
  /** "plain" = safeStorage had no keyring to talk to; the ui says so rather than pretending */
  key_storage: "encrypted" | "plain" | "none";
  active_model: string | null;
  models: string[]; // last successful listing; survives the server being down
  models_fetched_at: number | null;
  strategy: Strategy;
  context_tokens: number | null;
  timeout_ms: number | null;
  /** USD per million tokens; null = don't estimate spend at all */
  price_in_usd: number | null;
  price_out_usd: number | null;
  /** per-connection: agreeing to send text to your own laptop is not agreeing to send it to a cloud */
  consented: boolean;
  spend_cents: number;
  /** loopback host — nothing leaves the machine, so the consent copy says that instead */
  local: boolean;
  probe: ProbeResult | null;
  probed_at: number | null;
  active: boolean;
}

/** What the renderer sends to create or update one. `key` absent = leave the stored key alone. */
export interface AiConnectionInput {
  id?: number;
  label?: string;
  preset?: string;
  base_url?: string;
  key?: string;
  /** the answer to "there is no keyring here, store it in the clear?" */
  allow_plain?: boolean;
  active_model?: string | null;
  context_tokens?: number | null;
  timeout_ms?: number | null;
  price_in_usd?: number | null;
  price_out_usd?: number | null;
  consented?: boolean;
}

/** A known endpoint, offered as a chip so nobody has to remember a base url. */
export interface AiPreset {
  id: string;
  label: string;
  base_url: string;
  wire: Wire;
  key_required: boolean;
  docs_url: string | null;
  local: boolean;
}

export interface AiSettings {
  active_connection_id: number | null;
  /** replace names with Speaker N before the transcript leaves the machine */
  pseudonymize: boolean;
}

export interface OverviewChanged {
  recording_id: number;
}

/** Which window of a split transcript is being read. Transient: nothing stores it. */
export interface OverviewProgress {
  recording_id: number;
  part: number;
  total: number;
}
