// Single seam between the UI and the backend. Off mocks since 08.2: the read side and the
// cheap writes are real. The pipeline commands (retry, backfill, models, cache) reach the
// main process and get a "not implemented until 08.x" error until their sub-phase lands.
import type {
  AskScope, AskThread, AskThreadSummary, AiAgentDiscovery, AiConnection, AiConnectionInput, AiPreset, AiSettings, BackfillEstimate, DiskUsage, JobDone, JobFailed, JobProgress, ModelDownloadProgress,
  ModelInfo, OverviewChanged, OverviewPayload, OverviewProgress, Person, ProbeResult, RecordingDetail,
  RecordingDiscovered, RecordingFilter, RecordingSort, RecordingSummary, Resolved, SearchHit,
  Settings, SupportModels, SystemStats, TaskStatus, WatchFolder,
  TerminologyApplyResult, TerminologyImportResult, TerminologyRule, TerminologyRuleInput,
  TranscriptChanged,
} from "./types";
import { mockCommands, mockEvents } from "./mock";

const USE_MOCK = false;

export const api = {
  listRecordings: (filter?: RecordingFilter, sort?: RecordingSort): Promise<RecordingSummary[]> =>
    USE_MOCK ? mockCommands.list_recordings(filter, sort) : invoke("list_recordings", { filter, sort }),
  getRecording: (id: number): Promise<RecordingDetail> =>
    USE_MOCK ? mockCommands.get_recording(id) : invoke("get_recording", { id }),
  search: (query: string, limit = 50): Promise<SearchHit[]> =>
    USE_MOCK ? mockCommands.search(query) : invoke("search", { query, limit }),
  setTitle: (id: number, title: string): Promise<void> =>
    USE_MOCK ? mockCommands.set_title(id, title) : invoke("set_title", { id, title }),
  renameSpeaker: (speaker_id: number, name: string): Promise<void> =>
    USE_MOCK ? mockCommands.rename_speaker(speaker_id, name) : invoke("rename_speaker", { speaker_id, name }),
  speakerSegmentCount: (speaker_id: number): Promise<number> =>
    USE_MOCK ? mockCommands.speaker_segment_count(speaker_id) : invoke("speaker_segment_count", { speaker_id }),
  mergeSpeakers: (recording_id: number, from_id: number, into_id: number): Promise<void> =>
    USE_MOCK
      ? mockCommands.merge_speakers(recording_id, from_id, into_id)
      : invoke("merge_speakers", { recording_id, from_id, into_id }),
  setSegmentSpeaker: (recording_id: number, segment_id: number, speaker_id: number | null): Promise<void> =>
    USE_MOCK
      ? mockCommands.set_segment_speaker(recording_id, segment_id, speaker_id)
      : invoke("set_segment_speaker", { recording_id, segment_id, speaker_id }),
  segmentNewSpeaker: (recording_id: number, segment_id: number): Promise<number> =>
    USE_MOCK
      ? mockCommands.segment_new_speaker(recording_id, segment_id)
      : invoke("segment_new_speaker", { recording_id, segment_id }),
  rediarize: (recording_id: number, speakers: number | null): Promise<void> =>
    USE_MOCK ? mockCommands.rediarize(recording_id, speakers) : invoke("rediarize", { recording_id, speakers }),
  listPeople: (): Promise<Person[]> =>
    USE_MOCK ? mockCommands.list_people() : invoke("list_people"),
  terminologyRules: (): Promise<TerminologyRule[]> =>
    USE_MOCK ? mockCommands.terminology_list() : invoke("terminology_list"),
  terminologyAdd: (input: TerminologyRuleInput): Promise<TerminologyRule> =>
    USE_MOCK ? mockCommands.terminology_add(input) : invoke("terminology_add", { ...input }),
  terminologyUpdate: (id: number, input: TerminologyRuleInput): Promise<TerminologyRule> =>
    USE_MOCK ? mockCommands.terminology_update(id, input) : invoke("terminology_update", { id, ...input }),
  terminologyDelete: (id: number): Promise<void> =>
    USE_MOCK ? mockCommands.terminology_delete(id) : invoke("terminology_delete", { id }),
  terminologyApplyLibrary: (): Promise<TerminologyApplyResult> =>
    USE_MOCK ? mockCommands.terminology_apply_library() : invoke("terminology_apply_library"),
  terminologyImport: (path: string): Promise<TerminologyImportResult> =>
    USE_MOCK ? mockCommands.terminology_import(path) : invoke("terminology_import", { path }),
  terminologyExport: (path: string): Promise<void> =>
    USE_MOCK ? mockCommands.terminology_export(path) : invoke("terminology_export", { path }),
  renamePerson: (id: number, name: string): Promise<void> =>
    USE_MOCK ? mockCommands.rename_person(id, name) : invoke("rename_person", { id, name }),
  forgetPerson: (id: number): Promise<void> =>
    USE_MOCK ? mockCommands.forget_person(id) : invoke("forget_person", { id }),
  retryJob: (recording_id: number): Promise<void> =>
    USE_MOCK ? mockCommands.retry_job(recording_id) : invoke("retry_job", { recording_id }),
  listWatchFolders: (): Promise<WatchFolder[]> =>
    USE_MOCK ? mockCommands.list_watch_folders() : invoke("list_watch_folders"),
  addWatchFolder: (path: string): Promise<WatchFolder> =>
    USE_MOCK ? mockCommands.add_watch_folder(path) : invoke("add_watch_folder", { path }),
  removeWatchFolder: (id: number): Promise<void> =>
    USE_MOCK ? mockCommands.remove_watch_folder(id) : invoke("remove_watch_folder", { id }),
  startBackfill: (folder_id: number): Promise<void> =>
    USE_MOCK ? mockCommands.start_backfill(folder_id) : invoke("start_backfill", { folder_id }),
  backfillEstimate: (folder_id: number): Promise<BackfillEstimate> =>
    USE_MOCK ? mockCommands.backfill_estimate(folder_id) : invoke("backfill_estimate", { folder_id }),
  setWatchFolderEnabled: (id: number, enabled: boolean): Promise<void> =>
    USE_MOCK ? mockCommands.set_watch_folder_enabled(id, enabled) : invoke("set_watch_folder_enabled", { id, enabled }),
  setWatchFolderTrackRule: (id: number, track_rule: string): Promise<void> =>
    USE_MOCK ? mockCommands.set_watch_folder_track_rule(id, track_rule) : invoke("set_watch_folder_track_rule", { id, track_rule }),
  getSettings: (): Promise<Settings> =>
    USE_MOCK ? mockCommands.get_settings() : invoke("get_settings"),
  setSetting: (key: string, value: string): Promise<Settings> =>
    USE_MOCK ? mockCommands.set_setting(key, value) : invoke("set_setting", { key, value }),
  listModels: (): Promise<ModelInfo[]> =>
    USE_MOCK ? mockCommands.list_models() : invoke("list_models"),
  supportModels: (): Promise<SupportModels> =>
    USE_MOCK ? mockCommands.support_models() : invoke("support_models"),
  downloadSupportModels: (): Promise<void> =>
    USE_MOCK ? mockCommands.download_support_models() : invoke("download_support_models"),
  detectedDevice: (): Promise<Resolved> =>
    USE_MOCK ? mockCommands.detected_device() : invoke("detected_device"),
  diskUsage: (): Promise<DiskUsage> =>
    USE_MOCK ? mockCommands.disk_usage() : invoke("disk_usage"),
  systemStats: (): Promise<SystemStats> =>
    USE_MOCK ? mockCommands.system_stats() : invoke("system_stats"),
  downloadModel: (tier: string): Promise<void> =>
    USE_MOCK ? mockCommands.download_model(tier) : invoke("download_model", { tier }),
  cancelModelDownload: (tier: string): Promise<void> =>
    USE_MOCK ? mockCommands.cancel_model_download(tier) : invoke("cancel_model_download", { tier }),
  clearCache: (): Promise<void> =>
    USE_MOCK ? mockCommands.clear_cache() : invoke("clear_cache"),
  getLogDir: (): Promise<string> =>
    USE_MOCK ? mockCommands.get_log_dir() : invoke("get_log_dir"),
  exportTranscript: (recording_id: number, format: string, dest_path: string): Promise<void> =>
    USE_MOCK ? mockCommands.export_transcript(recording_id, format, dest_path) : invoke("export_transcript", { recording_id, format, dest_path }),
  copyTranscript: (recording_id: number, format: string): Promise<void> =>
    USE_MOCK ? mockCommands.copy_transcript(recording_id, format) : invoke("copy_transcript", { recording_id, format }),
  openInDefaultPlayer: (recording_id: number): Promise<void> =>
    USE_MOCK ? mockCommands.open_in_default_player(recording_id) : invoke("open_in_default_player", { recording_id }),

  // ------------------------------------------------------------------ ai overview

  personSetMe: (id: number | null): Promise<void> =>
    USE_MOCK ? mockCommands.person_set_me(id) : invoke("person_set_me", { id }),
  personSetRole: (id: number, role: string): Promise<void> =>
    USE_MOCK ? mockCommands.person_set_role(id, role) : invoke("person_set_role", { id, role }),
  overviewGet: (recording_id: number): Promise<OverviewPayload> =>
    USE_MOCK ? mockCommands.overview_get(recording_id) : invoke("overview_get", { recording_id }),
  /** Resolves when the call has landed — it costs money, so nothing calls this on a render. */
  overviewGenerate: (recording_id: number): Promise<OverviewPayload> =>
    USE_MOCK ? mockCommands.overview_generate(recording_id) : invoke("overview_generate", { recording_id }),
  overviewCancel: (recording_id: number): Promise<void> =>
    USE_MOCK ? mockCommands.overview_cancel(recording_id) : invoke("overview_cancel", { recording_id }),
  taskSetStatus: (id: number, status: TaskStatus): Promise<void> =>
    USE_MOCK ? mockCommands.task_set_status(id, status) : invoke("task_set_status", { id, status }),
  taskUpdate: (id: number, patch: { text?: string; owner_speaker_id?: number | null; due_date?: string | null }): Promise<void> =>
    USE_MOCK ? mockCommands.task_update(id, patch) : invoke("task_update", { id, ...patch }),

  // -------------------------------------------------------------------------- ask

  askThreads: (search = ""): Promise<AskThreadSummary[]> => invoke("ask_threads", { search }),
  askThread: (id: number): Promise<AskThread> => invoke("ask_thread", { id }),
  askSend: (input: {
    request_id: string;
    thread_id: number | null;
    scope: AskScope;
    question: string;
  }): Promise<AskThread> => invoke("ask_send", input),
  askCancel: (request_id: string): Promise<void> => invoke("ask_cancel", { request_id }),
  askRename: (id: number, title: string): Promise<void> => invoke("ask_rename", { id, title }),
  askDelete: (id: number): Promise<void> => invoke("ask_delete", { id }),

  aiSettings: (): Promise<AiSettings> =>
    USE_MOCK ? mockCommands.ai_settings_get() : invoke("ai_settings_get"),
  aiSettingsSet: (patch: { pseudonymize?: boolean; fallback_connection_id?: number | null }): Promise<AiSettings> =>
    USE_MOCK ? mockCommands.ai_settings_set(patch) : invoke("ai_settings_set", patch),
  aiPresets: (): Promise<AiPreset[]> =>
    USE_MOCK ? mockCommands.ai_presets() : invoke("ai_presets"),
  aiDetectAgents: (): Promise<AiAgentDiscovery[]> =>
    USE_MOCK ? mockCommands.ai_detect_agents() : invoke("ai_detect_agents"),
  aiConnections: (): Promise<AiConnection[]> =>
    USE_MOCK ? mockCommands.ai_connections_list() : invoke("ai_connections_list"),
  /** `key` absent leaves the stored one alone; `allow_plain` answers "no keyring — store it in the clear?". */
  aiConnectionSave: (input: AiConnectionInput): Promise<AiConnection> =>
    USE_MOCK ? mockCommands.ai_connection_save(input) : invoke("ai_connection_save", { ...input } as Record<string, unknown>),
  aiConnectionDelete: (id: number): Promise<AiConnection[]> =>
    USE_MOCK ? mockCommands.ai_connection_delete(id) : invoke("ai_connection_delete", { id }),
  aiConnectionActivate: (id: number): Promise<AiConnection[]> =>
    USE_MOCK ? mockCommands.ai_connection_activate(id) : invoke("ai_connection_activate", { id }),
  /** The four-rung setup test. Slow by nature — it really generates something. */
  aiConnectionTest: (id: number): Promise<ProbeResult> =>
    USE_MOCK ? mockCommands.ai_connection_test(id) : invoke("ai_connection_test", { id }),
  /** By base url, so the add form can show a list before there is anything to save. */
  aiModelsFetch: (q: { id?: number; preset?: string; base_url?: string; key?: string }): Promise<string[]> =>
    USE_MOCK ? mockCommands.ai_models_fetch(q) : invoke("ai_models_fetch", q),
  /** Local servers that answered a knock. Empty is the normal case, not a failure. */
  aiDetectLocal: (): Promise<{ preset: string; base_url: string; models: string[] }[]> =>
    USE_MOCK ? mockCommands.ai_detect_local() : invoke("ai_detect_local"),
  aiNormalizeUrl: (base_url: string): Promise<string> =>
    USE_MOCK ? mockCommands.ai_normalize_url(base_url) : invoke("ai_normalize_url", { base_url }),
};

// Native dialogs, the file manager and autostart. Never mocked — these are the main
// process's job whether or not the data layer exists yet.
export const os = {
  pickFolder: (): Promise<string | null> => invoke("open_folder"),
  pickFile: (): Promise<string | null> => invoke("open_file"),
  saveFile: (default_path: string, filters?: { name: string; extensions: string[] }[]): Promise<string | null> =>
    invoke("save_file", { default_path, filters }),
  openPath: (path: string): Promise<void> => invoke("open_path", { path }),
  getAutostart: (): Promise<boolean> => invoke("get_autostart"),
  setAutostart: (on: boolean): Promise<void> => invoke("set_autostart", { on }),
};

/** `<video src>` for a recording. The renderer never handles a filesystem path. */
export const mediaUrl = (recording_id: number): string => `unottr://media/${recording_id}`;

/** Must match PREVIEW_COUNT in src/main/media/thumbs.ts. */
export const PREVIEW_COUNT = 10;

/** Cover frame, generated once video recordings finish probing. 404s until then. */
export const thumbUrl = (recording_id: number): string => `unottr://thumb/${recording_id}`;

/** One of PREVIEW_COUNT frames evenly spaced across the recording, for hover slideshows. */
export const previewUrl = (recording_id: number, index: number): string =>
  `unottr://preview/${recording_id}/${index}`;

/** The still at one moment. Extracted on first request, so the first paint is ~50 ms late. */
export const frameUrl = (recording_id: number, ms: number): string =>
  `unottr://frame/${recording_id}/${ms}`;

export function onJobProgress(cb: (p: JobProgress) => void): () => void {
  if (USE_MOCK) return mockEvents.job_progress(cb);
  return listen<JobProgress>("job_progress", cb);
}
export function onJobDone(cb: (p: JobDone) => void): () => void {
  if (USE_MOCK) return mockEvents.job_done(cb);
  return listen<JobDone>("job_done", cb);
}
export function onJobFailed(cb: (p: JobFailed) => void): () => void {
  if (USE_MOCK) return mockEvents.job_failed(cb);
  return listen<JobFailed>("job_failed", cb);
}
export function onRecordingDiscovered(cb: (p: RecordingDiscovered) => void): () => void {
  if (USE_MOCK) return mockEvents.recording_discovered(cb);
  return listen<RecordingDiscovered>("recording_discovered", cb);
}
export function onTranscriptChanged(cb: (p: TranscriptChanged) => void): () => void {
  if (USE_MOCK) return mockEvents.transcript_changed(cb);
  return listen<TranscriptChanged>("transcript_changed", cb);
}
export function onModelDownloadProgress(cb: (p: ModelDownloadProgress) => void): () => void {
  if (USE_MOCK) return mockEvents.model_download_progress(cb);
  return listen<ModelDownloadProgress>("model_download_progress", cb);
}
export function onOverviewChanged(cb: (p: OverviewChanged) => void): () => void {
  if (USE_MOCK) return mockEvents.overview_changed(cb);
  return listen<OverviewChanged>("overview_changed", cb);
}

export function onOverviewProgress(cb: (p: OverviewProgress) => void): () => void {
  if (USE_MOCK) return mockEvents.overview_progress(cb);
  return listen<OverviewProgress>("overview_progress", cb);
}

function listen<T>(event: string, cb: (payload: T) => void): () => void {
  return window.unottr.on<T>(event, cb);
}

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return window.unottr.invoke<T>(cmd, args);
}
