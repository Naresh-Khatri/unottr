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

export type DiarizationEngine = "sortformer-vulkan" | "sherpa-cpu";

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

/** A confirmed speaker cluster that contributed to a person's voiceprint. */
export interface PersonVoiceSampleReference {
  id: number;
  recording_id: number;
  recording_title: string;
  speaker_id: number | null; // null after a re-diarization replaces the original speaker row
  speaker_label: string;
  recorded_at: number | null;
  captured_at: number;
  available: boolean;
}

export interface PersonDetails extends Person {
  sample_references: PersonVoiceSampleReference[];
  /** Samples created before source tracking existed, or whose recording was later removed. */
  unreferenced_samples: number;
}

export interface RecordingSummary {
  id: number;
  path: string;
  filename: string;
  /** user title, else the AI one; null -> fall back to `filename` (decision #32) */
  title: string | null;
  created_at: number; // unix seconds; when the recording entered the library
  recorded_at: number | null; // unix seconds
  duration_ms: number | null;
  /** Wall-clock compute time for the most recently completed transcription run. */
  transcription_duration_ms: number | null;
  /** Wall-clock compute time for the most recently completed diarization run. */
  diarization_duration_ms: number | null;
  status: Status;
  stage_detail: string | null;
  error: string | null; // typed-error slug when status=failed
  speaker_count: number;
  diarization_engine: DiarizationEngine | null;
  speaker_limit_hit: boolean;
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

export interface TerminologyRule {
  id: number;
  source: string;
  replacement: string;
  case_sensitive: boolean;
  whole_word: boolean;
  enabled: boolean;
  created_at: number;
  updated_at: number;
}

export interface TerminologyRuleInput {
  source: string;
  replacement: string;
  case_sensitive: boolean;
  whole_word: boolean;
  enabled: boolean;
}

export interface TerminologyApplyResult {
  recordings_changed: number;
  segments_changed: number;
}

export interface TerminologyImportResult {
  rules_imported: number;
}

export interface RecordingFilter {
  status?: Status;
  available?: boolean;
  query?: string;
}

export interface RecordingSort {
  by: "created_at" | "recorded_at" | "duration_ms" | "filename";
  dir: "asc" | "desc";
}

/** Slow work inside a persisted pipeline stage that needs its own honest UI state. */
export type JobPhase =
  | "queued"
  | "waiting_for_source"
  | "generating_previews"
  | "preparing_audio"
  | "mixing_tracks"
  | "connecting_model"
  | "downloading_model"
  | "verifying_model"
  | "detecting_speech"
  | "detecting_mic_speech"
  | "retrying_on_cpu"
  | "retrying_with_smaller_model"
  | "finishing"
  | null;

// main -> renderer events. pct is 0..1.
export interface JobProgress {
  recording_id: number;
  stage: Status;
  pct: number;
  /** Null once the stage is reporting ordinary percentage progress. */
  phase: JobPhase;
  /** Whether this run includes both compute steps or only the requested one. */
  mode: "full" | "transcribe" | "diarize";
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

export interface LibraryRefreshResult {
  /** Files noticed by the watcher that are still settling or being checked. */
  pending_files: number;
}

/** A watched file before it is safe to promote into the recordings table. */
export interface IncomingFileProgress {
  path: string;
  filename: string;
  phase: "waiting_for_copy" | "checking_file" | "done";
  /** Stability checks completed. Zero while the file is still changing. */
  done: number;
  total: number;
}

export interface TranscriptChanged {
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
  ask_speak_answers: boolean;
  tts_voice_id: TtsVoiceId;
  tray_available: boolean; // runtime fact, not a persisted setting
  autostart_available: boolean; // disabled on platforms without an implementation
  first_run_complete: boolean; // ui-only, gates first-run wizard
  ffmpeg_ok: boolean; // runtime fact, re-checked on every get/set_settings call
}

export interface ModelInfo {
  tier: "turbo" | "medium" | "small";
  name: string;
  size: number; // bytes
  downloaded: boolean;
  recommended: boolean;
  /** downloaded with platform support models */
  recovery: boolean;
}

/**
 * Everything a job needs besides the whisper tier — VAD, segmentation, speaker embedding,
 * and Sortformer on machines where its Vulkan runtime can run. The UI treats it as one set.
 */
export interface SupportModels {
  ready: boolean;
  /** Bytes still to fetch; 0 once ready. */
  missing_bytes: number;
}

/** `ModelDownloadProgress.model` for the support set, which has no tier of its own. */
export const SUPPORT_MODELS = "support";
export const TTS_VOICE_IDS = [
  "en_US-norman-medium",
  "en_US-ljspeech-medium",
  "en_US-lessac-medium",
  "en_US-kristin-medium",
  "en_US-amy-medium",
  "en_GB-cori-medium",
  "en_GB-alan-medium",
] as const;
export type TtsVoiceId = (typeof TTS_VOICE_IDS)[number];
export const DEFAULT_TTS_VOICE_ID: TtsVoiceId = "en_US-lessac-medium";
export const TTS_VOICE_DOWNLOAD_PREFIX = "tts_voice:";
export const ttsVoiceDownloadId = (voiceId: TtsVoiceId): string =>
  `${TTS_VOICE_DOWNLOAD_PREFIX}${voiceId}`;
export const isTtsVoiceDownload = (id: string): boolean => id.startsWith(TTS_VOICE_DOWNLOAD_PREFIX);

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

export interface BackfillProgress {
  folder_id: number;
  done: number;
  total: number;
  phase: "fingerprinting" | "queueing" | "done";
  error?: string;
}

export type ExportFormat = "txt" | "json" | "srt" | "vtt";

export type ModelDownloadPhase =
  | "connecting"
  | "downloading"
  | "verifying"
  | "installing"
  | "done";

export interface ModelDownloadProgress {
  model: string; // tier name, support set, or a prefixed TTS voice id
  /** 0..1. Reaches 1 only once the file is verified and renamed into place, never mid-stream. */
  pct: number;
  phase: ModelDownloadPhase;
  /** Set when the download stopped early — `cancelled`, or a download_failed reason. Terminal. */
  error?: string;
}

export interface TtsVoiceStatus {
  voice_id: TtsVoiceId;
  display_name: string;
  language: string;
  state: "missing" | "installed";
  download_bytes: number;
  installed_bytes: number;
}

export interface TtsSpeakInput {
  request_id: string;
  sentences: string[];
}

export type TtsEvent =
  | { type: "ready" }
  | { type: "audio"; request_id: string; sequence: number; samples: Float32Array; sample_rate: number }
  | { type: "done"; request_id: string }
  | { type: "stopped"; request_id: string }
  | { type: "error"; request_id: string | null; message: string };

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
  /** the prompt, transcript, role or cast has moved on since this was written; offer a regenerate */
  stale: boolean;
  /** what changed, so the nudge can name it; null when it is not stale */
  stale_reason: "speakers" | "transcript" | "role" | "prompt" | null;
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

/** HTTP endpoints and installed agent CLIs share selection, but not configuration. */
export type AiConnectionKind = "http" | "cli";

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

export interface ProbeProgress {
  connection_id: number;
  rungs: ProbeRung[];
  active_step: ProbeStep;
  /** The structured-output strategy currently being tried, when the probe reached that point. */
  strategy: Strategy | null;
}

export interface AiConnection {
  id: number;
  label: string;
  preset: string; // a PRESETS id, or "custom"
  kind: AiConnectionKind;
  wire: Wire;
  base_url: string;
  /** Absolute executable selected during discovery. Present only for installed CLIs. */
  executable_path: string | null;
  /** A CLI runs here, but the provider may still receive the transcript over the network. */
  subscription_managed: boolean;
  beta: boolean;
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
  executable_path?: string;
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
  kind: AiConnectionKind;
  base_url: string;
  wire: Wire;
  key_required: boolean;
  docs_url: string | null;
  local: boolean;
  /** Executable name for installed CLI presets. */
  executable: string | null;
  beta: boolean;
}

export interface AiSettings {
  active_connection_id: number | null;
  /** Used only when the active connection is a CLI. Must name an HTTP connection. */
  fallback_connection_id: number | null;
  /** replace names with Speaker N before the transcript leaves the machine */
  pseudonymize: boolean;
}

export interface AiAgentDiscovery {
  preset: string;
  label: string;
  executable_path: string | null;
  installed: boolean;
  beta: boolean;
  supported: boolean;
  detail: string;
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

export interface AskProgress {
  request_id: string;
  phase: "searching" | "asking_model" | "checking_answer" | "saving";
}

// Ask. Threads keep a fixed scope so a follow-up cannot silently search a different corpus.

export interface AskScope {
  /** Empty means every eligible recording. */
  recording_ids: number[];
  /** A recording matches when any linked speaker belongs to one of these people. */
  person_ids: number[];
  /** Inclusive unix-second meeting-date bounds. */
  date_from: number | null;
  date_to: number | null;
}

export interface AskThreadSummary {
  id: number;
  title: string;
  scope: AskScope;
  created_at: number;
  updated_at: number;
  message_count: number;
}

export interface AskCitation {
  kind: "transcript" | "workspace";
  recording_id: number;
  recording_title: string;
  meeting_date: number | null;
  segment_id: number | null;
  task_id: number | null;
  start_ms: number;
  speaker: string | null;
  excerpt: string | null;
  source_changed: boolean;
  unavailable: boolean;
}

export interface AskAnswerBlock {
  text: string;
  citations: AskCitation[];
}

export interface AskMessage {
  id: number;
  thread_id: number;
  role: "user" | "assistant";
  text: string;
  blocks: AskAnswerBlock[];
  follow_ups: string[];
  provider: string | null;
  model: string | null;
  searched_recordings: number;
  used_recordings: number;
  created_at: number;
}

export interface AskThread extends AskThreadSummary {
  messages: AskMessage[];
}

export interface AskSendInput {
  request_id: string;
  thread_id: number | null;
  scope: AskScope;
  question: string;
}
