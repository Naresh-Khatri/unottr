// Single seam between the UI and the backend. Off mocks since 08.2: the read side and the
// cheap writes are real. The pipeline commands (retry, backfill, models, cache) reach the
// main process and get a "not implemented until 08.x" error until their sub-phase lands.
import type {
  BackfillEstimate, DiskUsage, JobDone, JobFailed, JobProgress, ModelDownloadProgress, ModelInfo,
  RecordingDetail, RecordingDiscovered, RecordingFilter, RecordingSort, RecordingSummary,
  Resolved, SearchHit, Settings, SystemStats, WatchFolder,
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
  renameSpeaker: (speaker_id: number, name: string): Promise<void> =>
    USE_MOCK ? mockCommands.rename_speaker(speaker_id, name) : invoke("rename_speaker", { speaker_id, name }),
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
  openInDefaultPlayer: (recording_id: number): Promise<void> =>
    USE_MOCK ? mockCommands.open_in_default_player(recording_id) : invoke("open_in_default_player", { recording_id }),
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
export function onModelDownloadProgress(cb: (p: ModelDownloadProgress) => void): () => void {
  if (USE_MOCK) return mockEvents.model_download_progress(cb);
  return listen<ModelDownloadProgress>("model_download_progress", cb);
}

function listen<T>(event: string, cb: (payload: T) => void): () => void {
  return window.unottr.on<T>(event, cb);
}

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return window.unottr.invoke<T>(cmd, args);
}
