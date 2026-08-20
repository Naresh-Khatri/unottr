import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import type { ModelInfo, RecordingFilter, RecordingSort } from "../../shared/ipc";
import { getAutostart, setAutostart } from "../autostart";
import { db } from "../db";
import * as queries from "../db/queries";
import { resetForRetry } from "../db/recordings";
import * as settingsDb from "../db/settings";
import * as watchFoldersDb from "../db/watch-folders";
import { events } from "../events";
import { load as loadTranscript, parseFormat, render } from "../export";
import * as backfill from "../ingest/backfill";
import { defaultIngestConfig } from "../ingest/config";
import { ingest } from "../ingest/runtime";
import { check, discover, fromSettings } from "../media/ffmpeg";
import * as catalog from "../models/catalog";
import { resolve } from "../models/device";
import { ensure, isPresent } from "../models/download";
import { logsDir, pcmCacheDir } from "../paths";

/** Live model downloads by tier, so `cancel_model_download` has something to abort. */
const downloads = new Map<string, AbortController>();

type Args = Record<string, unknown> | undefined;
type Handler = (args: Args, win: BrowserWindow | null) => unknown;

// Whether the tray icon actually got built, not whether the platform claims to support one —
// same meaning as the rust build's `tray.is_some()`. Set from index.ts once Tray.build ran.
let trayAvailable = false;
export const setTrayAvailable = (v: boolean): void => {
  trayAvailable = v;
};

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

function requireId(a: Args, key: string): number {
  const v = num(a?.[key]);
  if (v === undefined) throw new Error(`missing ${key}`);
  return v;
}

function requireFolder(id: number): { path: string } {
  const folder = watchFoldersDb.get(db(), id);
  if (!folder) throw new Error(`watch folder ${id} not found`);
  return folder;
}

// modal on the window when there is one; the overload split is electron's, not ours
const openDialog = (win: BrowserWindow | null, o: Electron.OpenDialogOptions) =>
  win ? dialog.showOpenDialog(win, o) : dialog.showOpenDialog(o);
const saveDialog = (win: BrowserWindow | null, o: Electron.SaveDialogOptions) =>
  win ? dialog.showSaveDialog(win, o) : dialog.showSaveDialog(o);

/**
 * Every command the renderer can name. The single funnel channel means an unknown name is
 * rejected here rather than silently ignored.
 */
const handlers: Record<string, Handler> = {
  // ------------------------------------------------------------------- recordings

  list_recordings: (a) =>
    queries.listRecordings(
      db(),
      (a?.filter as RecordingFilter | undefined) ?? {},
      (a?.sort as RecordingSort | undefined) ?? { by: "recorded_at", dir: "desc" },
    ),

  get_recording(a) {
    const id = requireId(a, "id");
    const detail = queries.getRecording(db(), id);
    if (!detail) throw new Error(`recording ${id} not found`);
    return detail;
  },

  search: (a) => queries.search(db(), str(a?.query) ?? "", num(a?.limit) ?? 50),

  rename_speaker: (a) => queries.renameSpeaker(db(), requireId(a, "speaker_id"), str(a?.name) ?? ""),

  // ---------------------------------------------------------------- watch folders

  list_watch_folders: () => watchFoldersDb.list(db()),

  add_watch_folder(a) {
    const path = str(a?.path);
    if (!path) throw new Error("add_watch_folder: no path");
    // preflight: refuse rather than register a folder whose every file is certain to park
    // on FfmpegMissing
    const s = settingsDb.load(db());
    if (!check(fromSettings(s.ffmpeg_path, s.ffprobe_path))) {
      throw new Error("ffmpeg/ffprobe not found — fix that in Settings before adding a folder");
    }
    return watchFoldersDb.addOrEnable(db(), path);
  },

  remove_watch_folder: (a) => watchFoldersDb.remove(db(), requireId(a, "id")),
  set_watch_folder_enabled: (a) => watchFoldersDb.setEnabled(db(), requireId(a, "id"), a?.enabled === true),
  set_watch_folder_track_rule: (a) =>
    watchFoldersDb.setTrackRule(db(), requireId(a, "id"), str(a?.track_rule) ?? "auto"),

  // -------------------------------------------------------------------- settings

  get_settings: () => queries.getSettings(db(), trayAvailable),

  set_setting(a) {
    const key = str(a?.key);
    const value = str(a?.value);
    if (key === undefined || value === undefined) throw new Error("set_setting: key and value required");
    const invalid = settingsDb.validate(key, value);
    if (invalid) throw new Error(invalid);
    return queries.setSetting(db(), key, value, trayAvailable);
  },

  disk_usage: () => queries.diskUsage(),
  get_log_dir: () => logsDir(),

  // ----------------------------------------------------------------------- files

  export_transcript(a) {
    const format = parseFormat(str(a?.format) ?? "");
    if (!format) throw new Error(`unknown export format ${a?.format}`);
    const dest = str(a?.dest_path);
    if (!dest) throw new Error("export_transcript: no dest_path");
    writeFileSync(dest, render(format, loadTranscript(db(), requireId(a, "recording_id"))));
  },

  /**
   * Takes an id, not a path — the path is read back from the row here so the renderer can
   * never hand an arbitrary path to the system opener.
   */
  async open_in_default_player(a) {
    const path = queries.recordingPath(db(), requireId(a, "recording_id"));
    if (!path || !existsSync(path) || !statSync(path).isFile()) {
      throw new Error(`${path} is not there any more`);
    }
    const err = await shell.openPath(path);
    if (err) throw new Error(err);
  },

  // ------------------------------------------------------------------- pipeline

  retry_job(a) {
    const id = requireId(a, "recording_id");
    // false = the row wasn't terminal (a stale or duplicate click); enqueueing then would run
    // a second copy of a job that is already in flight
    if (resetForRetry(db(), id)) ingest()?.enqueue(id);
  },

  /** Scans and confirms in one shot — the explicit-confirmation requirement is satisfied by
   *  the user clicking the button that invokes this in the first place. */
  async start_backfill(a) {
    const folder = requireFolder(requireId(a, "folder_id"));
    for (const id of await backfill.confirm(db(), folder.path, defaultIngestConfig())) {
      ingest()?.enqueue(id);
    }
  },

  /** Read-only counterpart to `start_backfill`: count and duration before the user commits. */
  backfill_estimate: (a) =>
    backfill.scan(requireFolder(requireId(a, "folder_id")).path, defaultIngestConfig(), discover()),

  // ------------------------------------------------------------ models & device

  /** `base.en` is cli-only, so it is not one of the three tiers settings offers. */
  list_models: (): ModelInfo[] =>
    catalog.WHISPER.filter((m) => m.name !== "base.en").map((m) => ({
      tier: catalog.modelNameToTier(m.name) as ModelInfo["tier"],
      name: m.name,
      size: m.size,
      downloaded: isPresent(m),
    })),

  detected_device: () => resolve("auto"),

  /**
   * Kicks off a background download and returns immediately; progress comes back over
   * `model_download_progress` events keyed by tier. One download per tier — a second call
   * abandons (does not stop) the first, harmless because `ensure` resumes the `.part` file.
   */
  download_model(a) {
    const tier = str(a?.tier);
    const name = tier ? catalog.tierToModelName(tier) : undefined;
    if (!tier || !name) throw new Error(`unknown model tier ${a?.tier}`);
    const spec = catalog.findWhisper(name);
    if (!spec) throw new Error(`model ${name} not registered`);

    const ac = new AbortController();
    downloads.set(tier, ac);
    void ensure(spec, {
      signal: ac.signal,
      onProgress: (pct) => events.modelDownloadProgress({ model: tier, pct }),
    }).catch((e: unknown) => {
      console.warn(`model download did not complete (${tier}):`, e);
    });
  },

  cancel_model_download(a) {
    downloads.get(str(a?.tier) ?? "")?.abort();
  },

  clear_cache() {
    const dir = pcmCacheDir();
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  },

  // -------------------------------------------------------------- os / native ui

  async open_folder(_a, win) {
    const r = await openDialog(win, { properties: ["openDirectory"] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  },
  async open_file(_a, win) {
    const r = await openDialog(win, { properties: ["openFile"] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  },
  async save_file(a, win) {
    const r = await saveDialog(win, {
      defaultPath: str(a?.default_path),
      filters: a?.filters as Electron.FileFilter[] | undefined,
    });
    return r.canceled ? null : (r.filePath ?? null);
  },
  async open_path(a) {
    const path = str(a?.path);
    if (!path) throw new Error("open_path: no path");
    const err = await shell.openPath(path);
    if (err) throw new Error(err);
  },
  get_autostart: () => getAutostart(),
  set_autostart: (a) => setAutostart(a?.on === true),
};

export function registerHandlers(): void {
  ipcMain.handle("unottr", async (event, channel: string, args: Args) => {
    const fn = handlers[channel];
    if (!fn) throw new Error(`unknown command: ${channel}`);
    return await fn(args, BrowserWindow.fromWebContents(event.sender));
  });
}
