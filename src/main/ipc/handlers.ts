import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import type {
  AiConnectionInput,
  ModelInfo,
  RecordingFilter,
  RecordingSort,
  SystemStats,
  TaskStatus,
} from "../../shared/ipc";
import * as ai from "../ai/generate";
import * as connections from "../ai/connections";
import { probe } from "../ai/probe";
import { PRESETS, chatDefault, listModels, modelContext, normalizeBaseUrl } from "../ai/providers";
import { getAutostart, setAutostart } from "../autostart";
import { db } from "../db";
import * as overviewsDb from "../db/overviews";
import * as peopleDb from "../db/people";
import * as queries from "../db/queries";
import { resetForRetry, statusOf } from "../db/recordings";
import * as settingsDb from "../db/settings";
import * as speakersDb from "../db/speakers";
import * as watchFoldersDb from "../db/watch-folders";
import { events } from "../events";
import { load as loadTranscript, parseFormat, render } from "../export";
import * as backfill from "../ingest/backfill";
import { defaultIngestConfig } from "../ingest/config";
import { ingest, jobCounts } from "../ingest/runtime";
import { check, discover, fromSettings } from "../media/ffmpeg";
import * as catalog from "../models/catalog";
import { resolve } from "../models/device";
import { ensure, isPresent } from "../models/download";
import { logsDir, pcmCacheDir } from "../paths";
import { sampleCpu, sampleGpu } from "../system/stats";

/** Live model downloads by tier, so `cancel_model_download` has something to abort. */
const downloads = new Map<string, AbortController>();

/** Overview generations in flight, so a user who changed their mind can stop paying for one. */
const generating = new Map<number, AbortController>();

/** Autodetect runs while the settings card is opening — it has to lose fast or not at all. */
const DETECT_MS = 600;

/** A deliberate "list my models" click, so it can afford to wait on a cold hosted api. */
const FETCH_MS = 10_000;

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

function requireConnection(a: Args): connections.Row {
  const row = connections.row(db(), requireId(a, "id"));
  if (!row) throw new Error(`no AI connection with id ${a?.id}`);
  return row;
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

  /** Overview hits lead, because a summary line answers "which meeting was that" faster. */
  search(a) {
    const query = str(a?.query) ?? "";
    const limit = num(a?.limit) ?? 50;
    if (!query.trim()) return [];
    return [...overviewsDb.searchOverviews(db(), query, 10), ...queries.search(db(), query, limit)];
  },

  set_title: (a) => queries.setTitle(db(), requireId(a, "id"), str(a?.title) ?? ""),

  /** Names the person behind the cluster, not just this row — see db/people.ts. */
  rename_speaker: (a) => queries.renameSpeaker(db(), requireId(a, "speaker_id"), str(a?.name) ?? ""),

  // ------------------------------------------------------- speaker fixes (decision #50)
  // None of these touches transcript text; each bumps speakers_version, which is what the
  // Overview tab reads to offer a regenerate.

  /** How many segments a merge would move — quoted in the inline confirm before it happens. */
  speaker_segment_count: (a) => speakersDb.segmentCount(db(), requireId(a, "speaker_id")),

  merge_speakers(a) {
    speakersDb.mergeSpeakers(db(), requireId(a, "from_id"), requireId(a, "into_id"));
    events.overviewChanged({ recording_id: requireId(a, "recording_id") });
  },

  set_segment_speaker(a) {
    const speakerId = a?.speaker_id === null ? null : requireId(a, "speaker_id");
    speakersDb.setSegmentSpeaker(db(), requireId(a, "segment_id"), speakerId);
    events.overviewChanged({ recording_id: requireId(a, "recording_id") });
  },

  segment_new_speaker(a) {
    const id = speakersDb.assignToNewSpeaker(db(), requireId(a, "segment_id"));
    events.overviewChanged({ recording_id: requireId(a, "recording_id") });
    return id;
  },

  /** Re-cluster at a count the user gave. Refused mid-pipeline: there is nothing to re-cluster
   *  yet, and the queue would fight the running job for the row's status. */
  rediarize(a) {
    const id = requireId(a, "recording_id");
    if (statusOf(db(), id) !== "done") throw new Error(`recording ${id} is not finished`);
    const speakers = a?.speakers === null ? null : num(a?.speakers);
    ingest()?.enqueue(id, { kind: "rediarize", speakers: speakers ?? null });
  },

  // ----------------------------------------------------------------------- people

  list_people: () => peopleDb.list(db()),
  rename_person: (a) => peopleDb.rename(db(), requireId(a, "id"), str(a?.name) ?? ""),
  /** Drops the voiceprint too, so a bad match stops spreading. */
  forget_person: (a) => peopleDb.forget(db(), requireId(a, "id")),

  /** `id: null` un-says it; setting anyone clears whoever held it before. */
  person_set_me: (a) => peopleDb.setMe(db(), a?.id === null ? null : requireId(a, "id")),
  person_set_role: (a) => peopleDb.setRole(db(), requireId(a, "id"), str(a?.role) ?? ""),

  // -------------------------------------------------------------------- ai overview

  overview_get: (a) => overviewsDb.getPayload(db(), requireId(a, "recording_id")),

  /**
   * Returns once the call has landed — the renderer awaits it rather than polling, and gets
   * `overview_changed` too so a second window follows along.
   */
  async overview_generate(a) {
    const id = requireId(a, "recording_id");
    const controller = new AbortController();
    generating.set(id, controller);
    try {
      await ai.generate(db(), id, controller.signal);
    } finally {
      generating.delete(id);
    }
    return overviewsDb.getPayload(db(), id);
  },

  overview_cancel(a) {
    generating.get(requireId(a, "recording_id"))?.abort();
  },

  task_set_status(a) {
    const status = str(a?.status);
    if (status !== "open" && status !== "done" && status !== "dismissed") {
      throw new Error(`unknown task status ${a?.status}`);
    }
    const recordingId = overviewsDb.setTaskStatus(db(), requireId(a, "id"), status as TaskStatus);
    events.overviewChanged({ recording_id: recordingId });
  },

  task_update(a) {
    const recordingId = overviewsDb.updateTask(db(), requireId(a, "id"), {
      text: str(a?.text),
      // undefined = leave alone, null = clear; `in` is the only way to tell them apart
      ...("owner_speaker_id" in (a ?? {}) ? { ownerSpeakerId: num(a?.owner_speaker_id) ?? null } : {}),
      ...("due_date" in (a ?? {}) ? { dueDate: str(a?.due_date) ?? null } : {}),
    });
    events.overviewChanged({ recording_id: recordingId });
  },

  // --------------------------------------------------------------- ai connections

  ai_settings_get: () => connections.settings(db()),

  ai_settings_set(a) {
    if ("pseudonymize" in (a ?? {})) {
      settingsDb.setRaw(db(), settingsDb.keys.AI_PSEUDONYMIZE, a?.pseudonymize ? "1" : "0");
    }
    return connections.settings(db());
  },

  ai_presets: () => PRESETS,

  /** Keys never travel back out; a connection reports that it has one, not what it is. */
  ai_connections_list: () => connections.list(db()),

  ai_connection_save: (a) => connections.save(db(), (a ?? {}) as AiConnectionInput),

  ai_connection_delete(a) {
    connections.remove(db(), requireId(a, "id"));
    return connections.list(db());
  },

  ai_connection_activate(a) {
    connections.activate(db(), requireId(a, "id"));
    return connections.list(db());
  },

  async ai_connection_test(a) {
    const row = requireConnection(a);
    return probe(db(), row);
  },

  /**
   * Fills the model dropdown. Takes a base url rather than only a saved id, because the add
   * form needs the list *before* there is a row — being asked to type a model id you could
   * have been shown is the whole reason people give up here.
   */
  async ai_models_fetch(a) {
    const id = typeof a?.id === "number" ? a.id : null;
    const row = id === null ? null : connections.row(db(), id);
    const presetId = str(a?.preset) ?? row?.preset ?? "custom";
    const baseUrl = normalizeBaseUrl(str(a?.base_url) ?? row?.baseUrl ?? "");
    if (!baseUrl) throw new Error("ai_models_fetch: no base_url");

    const spec = PRESETS.find((p) => p.id === presetId);
    // a typed-but-unsaved key beats the stored one; both beat nothing
    const key = str(a?.key) || (row ? connections.keyOf(row) : null);
    const models = await listModels(baseUrl, key, spec?.wire ?? "openai", AbortSignal.timeout(FETCH_MS), presetId);
    if (row) {
      connections.setModels(db(), row.id, models);
      // a row with no model is a broken Generate; the list we just fetched answers it
      const fill = row.activeModel ? null : chatDefault(models);
      if (fill) connections.setActiveModel(db(), row.id, fill);
      const modelId = row.activeModel ?? fill;
      // learn the window once, and never over a number the user typed themselves
      if (modelId && !row.contextTokens) {
        const ctx = await modelContext(baseUrl, modelId, presetId, AbortSignal.timeout(FETCH_MS));
        if (ctx) connections.setContextTokens(db(), row.id, ctx);
      }
    }
    return models;
  },

  /**
   * Knock on the two local servers worth knocking on, so someone already running Ollama sees
   * it offered instead of being asked for a base url they'd have to go look up. Silent on
   * failure — "nothing found" is the common case and is not an error.
   */
  async ai_detect_local() {
    const found: { preset: string; base_url: string; models: string[] }[] = [];
    await Promise.all(
      PRESETS.filter((p) => p.local).map(async (p) => {
        try {
          const models = await listModels(p.base_url, null, p.wire, AbortSignal.timeout(DETECT_MS), p.id);
          found.push({ preset: p.id, base_url: p.base_url, models });
        } catch {
          // not running, wrong port, or something else entirely on 11434 — either way, no
        }
      }),
    );
    return found;
  },

  ai_normalize_url: (a) => normalizeBaseUrl(str(a?.base_url) ?? ""),

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

  /** Polled once a second or so by the sidebar meters — keep every reader in here cheap. */
  async system_stats(): Promise<SystemStats> {
    const { active, total } = jobCounts();
    return {
      cpu: sampleCpu(),
      gpu: await sampleGpu(),
      device: resolve(settingsDb.load(db()).device),
      jobs_active: active,
      jobs_queued: Math.max(0, total - active),
    };
  },

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
