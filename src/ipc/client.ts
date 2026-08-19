// Single seam between the UI and the backend. USE_MOCK stays around only so the mock file
// keeps compiling for reference; the real src-tauri commands are wired now.
import type {
  BackfillEstimate, DiskUsage, JobDone, JobFailed, JobProgress, ModelDownloadProgress, ModelInfo,
  RecordingDetail, RecordingDiscovered, RecordingFilter, RecordingSort, RecordingSummary,
  Resolved, SearchHit, Settings, WatchFolder,
} from "./types";
import { mockCommands, mockJobProgress } from "./mock";

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

  // phase 06 — not mocked; USE_MOCK is permanently false so this is fine (see header comment).
  backfillEstimate: (folder_id: number): Promise<BackfillEstimate> =>
    invoke("backfill_estimate", { folder_id }),
  setWatchFolderEnabled: (id: number, enabled: boolean): Promise<void> =>
    invoke("set_watch_folder_enabled", { id, enabled }),
  setWatchFolderTrackRule: (id: number, track_rule: string): Promise<void> =>
    invoke("set_watch_folder_track_rule", { id, track_rule }),
  getSettings: (): Promise<Settings> => invoke("get_settings"),
  setSetting: (key: string, value: string): Promise<Settings> => invoke("set_setting", { key, value }),
  listModels: (): Promise<ModelInfo[]> => invoke("list_models"),
  detectedDevice: (): Promise<Resolved> => invoke("detected_device"),
  diskUsage: (): Promise<DiskUsage> => invoke("disk_usage"),
  downloadModel: (tier: string): Promise<void> => invoke("download_model", { tier }),
  cancelModelDownload: (tier: string): Promise<void> => invoke("cancel_model_download", { tier }),
  clearCache: (): Promise<void> => invoke("clear_cache"),
  getLogDir: (): Promise<string> => invoke("get_log_dir"),
  exportTranscript: (recording_id: number, format: string, dest_path: string): Promise<void> =>
    invoke("export_transcript", { recording_id, format, dest_path }),
};

export function onJobProgress(cb: (p: JobProgress) => void): () => void {
  if (USE_MOCK) return mockJobProgress(cb);
  return listenTyped<JobProgress>("job_progress", cb);
}
export function onJobDone(cb: (p: JobDone) => void): () => void {
  return listenTyped<JobDone>("job_done", cb);
}
export function onJobFailed(cb: (p: JobFailed) => void): () => void {
  return listenTyped<JobFailed>("job_failed", cb);
}
export function onRecordingDiscovered(cb: (p: RecordingDiscovered) => void): () => void {
  return listenTyped<RecordingDiscovered>("recording_discovered", cb);
}
export function onModelDownloadProgress(cb: (p: ModelDownloadProgress) => void): () => void {
  return listenTyped<ModelDownloadProgress>("model_download_progress", cb);
}

// lazy so the mock build never imports tauri
function listenTyped<T>(event: string, cb: (payload: T) => void): () => void {
  let un = () => {};
  import("@tauri-apps/api/event").then(({ listen }) =>
    listen<T>(event, (e) => cb(e.payload)).then((f) => (un = f)));
  return () => un();
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}
