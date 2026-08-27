import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import type {
  AskScope,
  AiConnectionInput,
  ModelInfo,
  ModelDownloadPhase,
  ModelDownloadProgress,
  RecordingFilter,
  RecordingSort,
  SupportModels,
  SystemStats,
  TaskStatus,
  TerminologyRuleInput,
} from "../../shared/ipc";
import { SUPPORT_MODELS } from "../../shared/ipc";
import * as ai from "../ai/generate";
import * as askAi from "../ai/ask";
import { detectAgents } from "../ai/cli";
import * as connections from "../ai/connections";
import { probe } from "../ai/probe";
import { PRESETS, chatDefault, listModels, modelContext, normalizeBaseUrl } from "../ai/providers";
import { getAutostart, setAutostart } from "../autostart";
import { db } from "../db";
import * as askDb from "../db/ask";
import * as overviewsDb from "../db/overviews";
import * as peopleDb from "../db/people";
import * as queries from "../db/queries";
import { resetForRetry, statusOf } from "../db/recordings";
import * as settingsDb from "../db/settings";
import * as speakersDb from "../db/speakers";
import * as terminologyDb from "../db/terminology";
import * as watchFoldersDb from "../db/watch-folders";
import { isCancelled } from "../errors";
import { events } from "../events";
import { load as loadTranscript, parseFormat, render } from "../export";
import * as backfill from "../ingest/backfill";
import { defaultIngestConfig } from "../ingest/config";
import { ingest, jobCounts } from "../ingest/runtime";
import { check, discover, fromSettings } from "../media/ffmpeg";
import * as catalog from "../models/catalog";
import { gpus, resolve } from "../models/device";
import { ensure, isPresent } from "../models/download";
import { modelPolicy, supportSpecs } from "../models/setup";
import {
  SORTFORMER,
  ensureSortformer,
  isSortformerPresent,
  sortformerRuntime,
} from "../models/sortformer";
import { logsDir, pcmCacheDir } from "../paths";
import { sampleHardware } from "../system/stats";

interface DownloadEntry {
  controller: AbortController;
  status: ModelDownloadProgress;
}

/** Live model downloads stay queryable so navigation never erases their UI state. */
const downloads = new Map<string, DownloadEntry>();

function publishDownload(
  model: string,
  entry: DownloadEntry,
  patch: Partial<Pick<ModelDownloadProgress, "pct" | "phase" | "error">>,
): void {
  if (downloads.get(model) !== entry) return;
  entry.status = { ...entry.status, ...patch };
  events.modelDownloadProgress(entry.status);
}

function beginDownload(model: string): DownloadEntry | null {
  const running = downloads.get(model);
  if (running) {
    events.modelDownloadProgress(running.status);
    return null;
  }
  const entry: DownloadEntry = {
    controller: new AbortController(),
    status: { model, pct: 0, phase: "connecting" },
  };
  downloads.set(model, entry);
  events.modelDownloadProgress(entry.status);
  return entry;
}

/** Sortformer is useful only when both the staged Vulkan runtime and a hardware GPU exist. */
const supportsFastDiarization = (): boolean => sortformerRuntime() !== null && gpus().length > 0;

/** Overview generations in flight, so a user who changed their mind can stop paying for one. */
const generating = new Map<number, AbortController>();

/** Ask calls are keyed by renderer-generated ids so a new, not-yet-persisted thread can stop. */
const asking = new Map<string, AbortController>();

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

function terminologyInput(a: Args): TerminologyRuleInput {
  return {
    source: str(a?.source) ?? "",
    replacement: str(a?.replacement) ?? "",
    case_sensitive: a?.case_sensitive === true,
    whole_word: a?.whole_word !== false,
    enabled: a?.enabled !== false,
  };
}

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
      (a?.sort as RecordingSort | undefined) ?? { by: "created_at", dir: "desc" },
    ),

  async refresh_library() {
    return { pending_files: await ingest()?.refresh() ?? 0 };
  },

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
    const rawSpeakers = a?.speakers;
    const speakers = rawSpeakers === null || rawSpeakers === undefined ? null : num(rawSpeakers);
    if (
      speakers === undefined ||
      (speakers !== null && (!Number.isInteger(speakers) || speakers < 1 || speakers > 20))
    ) {
      throw new Error("speaker count must be a whole number from 1 to 20");
    }
    ingest()?.enqueue(id, { kind: "rediarize", speakers });
  },

  // ----------------------------------------------------------------------- people

  list_people: () => peopleDb.list(db()),
  rename_person: (a) => peopleDb.rename(db(), requireId(a, "id"), str(a?.name) ?? ""),
  /** Drops the voiceprint too, so a bad match stops spreading. */
  forget_person: (a) => peopleDb.forget(db(), requireId(a, "id")),

  /** `id: null` un-says it; setting anyone clears whoever held it before. */
  person_set_me: (a) => peopleDb.setMe(db(), a?.id === null ? null : requireId(a, "id")),
  person_set_role: (a) => peopleDb.setRole(db(), requireId(a, "id"), str(a?.role) ?? ""),

  // ------------------------------------------------------------- terminology memory

  terminology_list: () => terminologyDb.list(db()),
  terminology_add: (a) => terminologyDb.create(db(), terminologyInput(a)),
  terminology_update: (a) => terminologyDb.update(db(), requireId(a, "id"), terminologyInput(a)),
  terminology_delete: (a) => terminologyDb.remove(db(), requireId(a, "id")),

  terminology_apply_library() {
    const report = terminologyDb.applyToLibrary(db());
    for (const recordingId of report.recordingIds) {
      events.transcriptChanged({ recording_id: recordingId });
      events.overviewChanged({ recording_id: recordingId });
    }
    return {
      recordings_changed: report.recordingIds.length,
      segments_changed: report.segmentsChanged,
    };
  },

  terminology_import(a) {
    const path = str(a?.path);
    if (!path) throw new Error("terminology_import: no path");
    if (statSync(path).size > 1_000_000) throw new Error("terminology file is larger than 1 MB");
    return { rules_imported: terminologyDb.importJson(db(), readFileSync(path, "utf8")) };
  },

  terminology_export(a) {
    const path = str(a?.path);
    if (!path) throw new Error("terminology_export: no path");
    writeFileSync(path, terminologyDb.serialize(db()));
  },

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

  // -------------------------------------------------------------------------- ask

  ask_threads: (a) => askDb.list(db(), str(a?.search) ?? ""),

  ask_thread(a) {
    const id = requireId(a, "id");
    const thread = askDb.get(db(), id);
    if (!thread) throw new Error(`thread ${id} not found`);
    return thread;
  },

  async ask_send(a) {
    const requestId = str(a?.request_id);
    if (!requestId) throw new Error("ask_send: request_id required");
    const threadId = a?.thread_id === null || a?.thread_id === undefined
      ? null
      : requireId(a, "thread_id");
    const controller = new AbortController();
    asking.set(requestId, controller);
    try {
      return await askAi.send(db(), {
        threadId,
        scope: askDb.normalizeScope((a?.scope as AskScope | undefined) ?? askDb.emptyScope()),
        question: str(a?.question) ?? "",
        signal: controller.signal,
        onProgress: (phase) => events.askProgress({ request_id: requestId, phase }),
      });
    } finally {
      if (asking.get(requestId) === controller) asking.delete(requestId);
    }
  },

  ask_cancel(a) {
    asking.get(str(a?.request_id) ?? "")?.abort();
  },

  ask_rename(a) {
    askDb.rename(db(), requireId(a, "id"), str(a?.title) ?? "");
  },

  ask_delete(a) {
    askDb.remove(db(), requireId(a, "id"));
  },

  // --------------------------------------------------------------- ai connections

  ai_settings_get: () => connections.settings(db()),

  ai_settings_set(a) {
    if ("pseudonymize" in (a ?? {})) {
      settingsDb.setRaw(db(), settingsDb.keys.AI_PSEUDONYMIZE, a?.pseudonymize ? "1" : "0");
    }
    if ("fallback_connection_id" in (a ?? {})) {
      connections.setFallback(db(), a?.fallback_connection_id === null ? null : requireId(a, "fallback_connection_id"));
    }
    return connections.settings(db());
  },

  ai_presets: () => PRESETS,

  ai_detect_agents: () => detectAgents(),

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
    return probe(db(), row, undefined, (rungs, activeStep, strategy) => {
      events.probeProgress({
        connection_id: row.id,
        rungs,
        active_step: activeStep,
        strategy,
      });
    });
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
    const hardware = await sampleHardware();
    return {
      ...hardware,
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

  /** Same render as the file export, straight onto the clipboard — nothing hits disk. */
  copy_transcript(a) {
    const format = parseFormat(str(a?.format) ?? "");
    if (!format) throw new Error(`unknown export format ${a?.format}`);
    clipboard.writeText(render(format, loadTranscript(db(), requireId(a, "recording_id"))));
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
    const was = statusOf(db(), id);
    // false = the row wasn't terminal (a stale or duplicate click); enqueueing then would run
    // a second copy of a job that is already in flight
    if (resetForRetry(db(), id)) {
      ingest()?.enqueue(id, was === "done" ? { kind: "retranscribe" } : undefined);
    }
  },

  /** Scans and confirms in one shot — the explicit-confirmation requirement is satisfied by
   *  the user clicking the button that invokes this in the first place. */
  async start_backfill(a) {
    const folderId = requireId(a, "folder_id");
    const folder = requireFolder(folderId);
    try {
      const ids = await backfill.confirm(
        db(),
        folder.path,
        defaultIngestConfig(),
        (done, total) => events.backfillProgress({
          folder_id: folderId,
          done,
          total,
          phase: "fingerprinting",
        }),
      );
      events.backfillProgress({
        folder_id: folderId,
        done: 0,
        total: ids.length,
        phase: "queueing",
      });
      for (const [index, id] of ids.entries()) {
        ingest()?.enqueue(id);
        events.backfillProgress({
          folder_id: folderId,
          done: index + 1,
          total: ids.length,
          phase: "queueing",
        });
      }
      events.backfillProgress({
        folder_id: folderId,
        done: ids.length,
        total: ids.length,
        phase: "done",
      });
    } catch (reason) {
      const error = reason instanceof Error ? reason.message : String(reason);
      events.backfillProgress({ folder_id: folderId, done: 0, total: 0, phase: "done", error });
      throw reason;
    }
  },

  /** Read-only counterpart to `start_backfill`: count and duration before the user commits. */
  backfill_estimate: (a) =>
    backfill.scan(requireFolder(requireId(a, "folder_id")).path, defaultIngestConfig(), discover()),

  // ------------------------------------------------------------ models & device

  /** `base.en` is cli-only, so it is not one of the three tiers settings offers. */
  list_models: (): ModelInfo[] => {
    const policy = modelPolicy();
    return catalog.WHISPER.filter((m) => m.name !== "base.en").map((m) => {
      const tier = catalog.modelNameToTier(m.name) as ModelInfo["tier"];
      return {
        tier,
        name: m.name,
        size: m.size,
        downloaded: isPresent(m),
        recommended: tier === policy.recommendedTier,
        recovery: tier === policy.recoveryTier,
      };
    });
  },

  support_models: (): SupportModels => {
    const missing = supportSpecs().filter((m) => !isPresent(m));
    const missingSortformer = supportsFastDiarization() && !isSortformerPresent();
    return {
      ready: missing.length === 0 && !missingSortformer,
      missing_bytes:
        missing.reduce((n, m) => n + m.size, 0) + (missingSortformer ? SORTFORMER.size : 0),
    };
  },

  model_download_status: (): ModelDownloadProgress[] =>
    [...downloads.values()].map((entry) => entry.status),

  /**
   * Same fire-and-forget shape as `download_model`, under the reserved `support` key. Fetched
   * one after another and reported as a single byte-weighted bar — there is no tier to pick
   * between, so separate bars would be several ways to say the same thing.
   */
  download_support_models() {
    const specs = supportSpecs();
    const includeSortformer = supportsFastDiarization();
    const total =
      specs.reduce((n, m) => n + m.size, 0) + (includeSortformer ? SORTFORMER.size : 0);
    const entry = beginDownload(SUPPORT_MODELS);
    if (!entry) return;
    const ac = entry.controller;

    void (async () => {
      let done = 0;
      for (const spec of specs) {
        await ensure(spec, {
          signal: ac.signal,
          onPhase: (phase) => {
            if (phase !== "done") publishDownload(SUPPORT_MODELS, entry, { phase });
          },
          onProgress: (pct) =>
            publishDownload(SUPPORT_MODELS, entry, {
              // the last one's terminal 1 is the only 1 the ui may see
              pct: Math.min((done + pct * spec.size) / total, 0.999),
            }),
        });
        done += spec.size;
      }
      if (includeSortformer) {
        await ensureSortformer({
          signal: ac.signal,
          onPhase: (phase) => {
            if (phase !== "done") publishDownload(SUPPORT_MODELS, entry, { phase });
          },
          onProgress: (pct) =>
            publishDownload(SUPPORT_MODELS, entry, {
              pct: Math.min((done + pct * SORTFORMER.size) / total, 0.999),
            }),
        });
      }
      publishDownload(SUPPORT_MODELS, entry, { pct: 1, phase: "done" });
    })()
      .catch((e: unknown) => {
        console.warn("support model download did not complete:", e);
        if (downloads.get(SUPPORT_MODELS) !== entry) return;
        const error = isCancelled(e) ? "cancelled" : e instanceof Error ? e.message : String(e);
        publishDownload(SUPPORT_MODELS, entry, { pct: 0, phase: "done", error });
      })
      .finally(() => {
        if (downloads.get(SUPPORT_MODELS) === entry) downloads.delete(SUPPORT_MODELS);
      });
  },

  detected_device: () => resolve("auto"),

  /**
   * Kicks off a background download and returns immediately; progress comes back over
   * `model_download_progress` events keyed by tier. One download per tier — a second call
   * abandons (does not stop) the first, harmless because `ensure` resumes the `.part` file.
   * Always ends in a terminal event (pct 1, or `error`) — the ui blocks on it.
   */
  download_model(a) {
    const tier = str(a?.tier);
    const name = tier ? catalog.tierToModelName(tier) : undefined;
    if (!tier || !name) throw new Error(`unknown model tier ${a?.tier}`);
    const spec = catalog.findWhisper(name);
    if (!spec) throw new Error(`model ${name} not registered`);

    const entry = beginDownload(tier);
    if (!entry) return;
    const ac = entry.controller;
    void ensure(spec, {
      signal: ac.signal,
      onPhase: (phase: ModelDownloadPhase) => publishDownload(tier, entry, { phase }),
      onProgress: (pct) => publishDownload(tier, entry, { pct }),
    })
      .catch((e: unknown) => {
        console.warn(`model download did not complete (${tier}):`, e);
        // a later call took over this tier; its progress is the one the ui is watching
        if (downloads.get(tier) !== entry) return;
        const error = isCancelled(e) ? "cancelled" : e instanceof Error ? e.message : String(e);
        publishDownload(tier, entry, { pct: 0, phase: "done", error });
      })
      .finally(() => {
        // a later call already replaced us; leave its controller alone
        if (downloads.get(tier) === entry) downloads.delete(tier);
      });
  },

  cancel_model_download(a) {
    downloads.get(str(a?.tier) ?? "")?.controller.abort();
  },

  async clear_cache() {
    const dir = pcmCacheDir();
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
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
