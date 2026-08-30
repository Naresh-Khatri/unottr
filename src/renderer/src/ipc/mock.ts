// Zero-backend mock of the IPC surface, matching docs/plan/05-ipc-contract.md.
// Carried over from phase 05; 08.1 runs the whole renderer on it while the main process
// has no data layer. 08.2 flips USE_MOCK back off.

import type {
  AskProgress,
  AiConnection,
  AiConnectionInput,
  AiPreset,
  AiSettings,
  ProbeResult,
  BackfillEstimate,
  BackfillProgress,
  DiskUsage,
  JobDone,
  JobFailed,
  JobProgress,
  IncomingFileProgress,
  LibraryRefreshResult,
  ModelDownloadProgress,
  ModelInfo,
  Overview,
  OverviewChanged,
  OverviewProgress,
  OverviewPayload,
  ProbeProgress,
  Person,
  PersonDetails,
  RecordingDetail,
  RecordingDiscovered,
  RecordingFilter,
  RecordingSort,
  RecordingSummary,
  Resolved,
  SearchHit,
  Segment,
  Settings,
  Speaker,
  SystemStats,
  Task,
  TaskStatus,
  TerminologyApplyResult,
  TerminologyImportResult,
  TerminologyRule,
  TerminologyRuleInput,
  TranscriptChanged,
  TtsEvent,
  TtsSpeakInput,
  TtsVoiceId,
  TtsVoiceStatus,
  WatchFolder,
} from "./types";
import { SUPPORT_MODELS, ttsVoiceDownloadId, type SupportModels } from "./types";

const speakers9001: Speaker[] = [
  { id: 9101, recording_id: 9001, label: "Speaker 1", display_name: "Priya", person_id: 1 },
  { id: 9102, recording_id: 9001, label: "Speaker 2", display_name: null, person_id: null },
];

let people: Person[] = [
  { id: 1, name: "Priya", samples: 3, recordings: 2, created_at: 1759700000, is_me: true, role: "Engineering manager" },
];

const segments9001: Segment[] = [
  { id: 1, chunk_idx: 0, start_ms: 1360, end_ms: 4200,
    text: "Yeah, let's start with the quarterly roadmap review.",
    words: [
      { text: "Yeah,", start_ms: 1360, end_ms: 1900, p: 0.93 },
      { text: "let's", start_ms: 2100, end_ms: 2600, p: 0.9 },
    ], speaker_id: 9101, split_of: null },
  { id: 2, chunk_idx: 0, start_ms: 4200, end_ms: 7800,
    text: "Sounds good, I pulled the numbers this morning.",
    words: [], speaker_id: 9102, split_of: null },
  { id: 3, chunk_idx: 1, start_ms: 7800, end_ms: 11200,
    text: "Great, walk me through the search latency first.",
    words: [], speaker_id: 9101, split_of: null },
  { id: 4, chunk_idx: 1, start_ms: 11200, end_ms: 13000,
    text: "(crosstalk)", words: [], speaker_id: null, split_of: null },
];

const recordings: RecordingSummary[] = [
  { id: 9001, path: "/home/naresh/fixtures/2025-10-06 roadmap-review.mp4",
    filename: "2025-10-06 roadmap-review.mp4", title: "Q4 roadmap trade-offs",
    created_at: 1787468400, recorded_at: 1759754411,
    duration_ms: 2130000, status: "done", stage_detail: null, error: null,
    transcription_duration_ms: 88400, diarization_duration_ms: 26900,
    speaker_count: 2, diarization_engine: "sortformer-vulkan", speaker_limit_hit: false,
    available: true, has_video: true },
  { id: 9002, path: "/home/naresh/fixtures/2026-08-18 standup.mp4",
    filename: "2026-08-18 standup.mp4", title: null,
    created_at: 1787554800, recorded_at: 1765000332,
    duration_ms: 1980000, status: "transcribing", stage_detail: "chunk 12/44",
    error: null, speaker_count: 0, diarization_engine: null, speaker_limit_hit: false,
    transcription_duration_ms: null, diarization_duration_ms: null,
    available: true, has_video: true },
  { id: 9003, path: "/home/naresh/fixtures/2025-10-12 interrupted.mp4",
    filename: "2025-10-12 interrupted.mp4", title: null,
    created_at: 1787382000, recorded_at: 1760276883,
    duration_ms: null, status: "failed", stage_detail: null, error: "Truncated",
    speaker_count: 0, diarization_engine: null, speaker_limit_hit: false,
    transcription_duration_ms: null, diarization_duration_ms: null,
    available: false, has_video: false },
];

let folders: WatchFolder[] = [
  { id: 1, path: "/home/naresh", track_rule: "auto", enabled: true },
];

let terminologyRules: TerminologyRule[] = [
  {
    id: 1,
    source: "post grass",
    replacement: "Postgres",
    case_sensitive: false,
    whole_word: true,
    enabled: true,
    created_at: 1787472000,
    updated_at: 1787472000,
  },
];

const wait = <T>(v: T, ms = 120): Promise<T> =>
  new Promise((r) => setTimeout(() => r(v), ms));

/** Stands in for the speakers_version bump every speaker fix makes on the recording. */
function markSpeakersStale(recording_id: number): void {
  if (overview.status !== "done") return;
  overview.stale = true;
  overview.stale_reason = "speakers";
  emit("overview_changed", { recording_id });
}

export const mockCommands = {
  refresh_library: (): Promise<LibraryRefreshResult> => wait({ pending_files: 0 }),
  list_recordings(filter?: RecordingFilter, sort?: RecordingSort) {
    let rows = recordings.slice();
    if (filter?.status) rows = rows.filter((r) => r.status === filter.status);
    if (filter?.available !== undefined)
      rows = rows.filter((r) => r.available === filter.available);
    if (sort) {
      const dir = sort.dir === "asc" ? 1 : -1;
      rows.sort((a, b) => {
        const av = a[sort.by] ?? 0, bv = b[sort.by] ?? 0;
        return av < bv ? -dir : av > bv ? dir : (a.id - b.id) * dir;
      });
    }
    return wait(rows);
  },
  get_recording(id: number): Promise<RecordingDetail> {
    const summary = recordings.find((r) => r.id === id)!;
    return wait({
      recording: { ...summary, container: "mov,mp4,m4a" },
      segments: id === 9001 ? segments9001 : [],
      speakers: id === 9001 ? speakers9001 : [],
    });
  },
  search(query: string): Promise<SearchHit[]> {
    const q = query.toLowerCase();
    const mark = (text: string) => text.replace(new RegExp(`(${query})`, "ig"), "<b>$1</b>");
    const hits: SearchHit[] = segments9001
      .filter((s) => s.text.toLowerCase().includes(q))
      .map((s) => ({
        kind: "transcript", recording_id: 9001, filename: recordings[0].filename, title: recordings[0].title,
        segment_id: s.id, start_ms: s.start_ms, snippet: mark(s.text),
      }));
    // overview hits sort first and carry no moment — clicking one opens the tab
    if (overview.tldr && overview.tldr.toLowerCase().includes(q)) {
      hits.unshift({
        kind: "overview", recording_id: 9001, filename: recordings[0].filename, title: recordings[0].title,
        segment_id: 0, start_ms: 0, snippet: mark(overview.tldr),
      });
    }
    return wait(hits);
  },
  set_title(id: number, title: string) {
    const r = recordings.find((x) => x.id === id);
    if (r) r.title = title.trim() || null;
    return wait(undefined);
  },
  rename_speaker(speaker_id: number, name: string) {
    const s = speakers9001.find((x) => x.id === speaker_id);
    if (!s) return wait(undefined);
    s.display_name = name || null;
    if (!name) s.person_id = null;
    else {
      const found = people.find((p) => p.name.toLowerCase() === name.toLowerCase());
      const person: Person =
        found ?? { id: people.length + 1, name, samples: 0, recordings: 1, created_at: 0, is_me: false, role: null };
      if (!found) people.push(person);
      person.samples++;
      s.person_id = person.id;
    }
    return wait(undefined);
  },

  // ----------------------------------------------------------- speaker fixes (#50)

  speaker_segment_count: (speaker_id: number) =>
    wait(segments9001.filter((s) => s.speaker_id === speaker_id).length),

  merge_speakers(recording_id: number, from_id: number, into_id: number) {
    const from = speakers9001.find((s) => s.id === from_id);
    const into = speakers9001.find((s) => s.id === into_id);
    if (!from || !into) return wait(undefined);
    for (const seg of segments9001) if (seg.speaker_id === from_id) seg.speaker_id = into_id;
    if (from.person_id !== null && into.person_id === null) {
      into.person_id = from.person_id;
      into.display_name = from.display_name;
    }
    speakers9001.splice(speakers9001.indexOf(from), 1);
    markSpeakersStale(recording_id);
    return wait(undefined);
  },

  set_segment_speaker(recording_id: number, segment_id: number, speaker_id: number | null) {
    const seg = segments9001.find((s) => s.id === segment_id);
    if (seg) seg.speaker_id = speaker_id;
    markSpeakersStale(recording_id);
    return wait(undefined);
  },

  segment_new_speaker(recording_id: number, segment_id: number) {
    const highest = speakers9001.reduce(
      (max, s) => Math.max(max, Number(/^Speaker (\d+)$/.exec(s.label)?.[1] ?? 0)),
      0,
    );
    const id = Math.max(9102, ...speakers9001.map((s) => s.id)) + 1;
    speakers9001.push({
      id, recording_id: 9001, label: `Speaker ${highest + 1}`, display_name: null, person_id: null,
    });
    const seg = segments9001.find((s) => s.id === segment_id);
    if (seg) seg.speaker_id = id;
    markSpeakersStale(recording_id);
    return wait(id);
  },

  /** No worker here, so it just reports the two events the real one would. */
  rediarize(recording_id: number, _speakers: number | null) {
    emit("job_progress", {
      recording_id,
      stage: "diarizing",
      pct: 0.4,
      phase: null,
      eta_ms: 8000,
      mode: "diarize",
    });
    setTimeout(() => {
      markSpeakersStale(recording_id);
      emit("job_done", { recording_id });
    }, 1500);
    return wait(undefined);
  },

  list_people: () => wait(people.slice()),
  person_details(id: number): Promise<PersonDetails> {
    const person = people.find((item) => item.id === id)!;
    return wait({
      ...person,
      sample_references: [
        {
          id: 1,
          recording_id: 9001,
          recording_title: "Q4 roadmap trade-offs",
          speaker_id: 9101,
          speaker_label: "Speaker 1",
          recorded_at: 1759754411,
          captured_at: 1787468400,
          available: true,
        },
      ],
      unreferenced_samples: Math.max(0, person.samples - 1),
    });
  },
  terminology_list: () => wait(terminologyRules.map((rule) => ({ ...rule }))),
  terminology_add(input: TerminologyRuleInput): Promise<TerminologyRule> {
    const ts = Math.floor(Date.now() / 1000);
    const rule = { id: Math.max(0, ...terminologyRules.map((x) => x.id)) + 1, ...input, created_at: ts, updated_at: ts };
    terminologyRules.push(rule);
    return wait({ ...rule });
  },
  terminology_update(id: number, input: TerminologyRuleInput): Promise<TerminologyRule> {
    const i = terminologyRules.findIndex((rule) => rule.id === id);
    const rule = { ...terminologyRules[i], ...input, updated_at: Math.floor(Date.now() / 1000) };
    terminologyRules[i] = rule;
    return wait({ ...rule });
  },
  terminology_delete(id: number) {
    terminologyRules = terminologyRules.filter((rule) => rule.id !== id);
    return wait(undefined);
  },
  terminology_apply_library: (): Promise<TerminologyApplyResult> =>
    wait({ recordings_changed: 1, segments_changed: 2 }),
  terminology_import: (_path: string): Promise<TerminologyImportResult> =>
    wait({ rules_imported: 1 }),
  terminology_export: (_path: string) => wait(undefined),
  rename_person(id: number, name: string) {
    const p = people.find((x) => x.id === id);
    if (p) p.name = name;
    for (const s of speakers9001) if (s.person_id === id) s.display_name = name;
    return wait(undefined);
  },
  forget_person(id: number) {
    people = people.filter((p) => p.id !== id);
    for (const s of speakers9001) {
      if (s.person_id === id) { s.person_id = null; s.display_name = null; }
    }
    return wait(undefined);
  },
  retry_job: (_id: number) => wait(undefined),
  add_watch_folder(path: string) {
    const f = { id: folders.length + 1, path, track_rule: "auto", enabled: true };
    folders.push(f);
    return wait(f);
  },
  remove_watch_folder(id: number) {
    folders = folders.filter((f) => f.id !== id);
    return wait(undefined);
  },
  list_watch_folders: () => wait(folders.slice()),
  start_backfill: (_folderId: number) => wait(undefined),

  // phase 06 surface
  backfill_estimate(folder_id: number): Promise<BackfillEstimate> {
    const f = folders.find((x) => x.id === folder_id);
    return wait({
      folder: f?.path ?? "/home/naresh",
      count: 7,
      total_duration_ms: 7 * 1800_000,
      estimated_processing_ms: 7 * 1800_000 / 8,
    });
  },
  set_watch_folder_enabled(id: number, enabled: boolean) {
    const f = folders.find((x) => x.id === id);
    if (f) f.enabled = enabled;
    return wait(undefined);
  },
  set_watch_folder_track_rule(id: number, track_rule: string) {
    const f = folders.find((x) => x.id === id);
    if (f) f.track_rule = track_rule;
    return wait(undefined);
  },
  get_settings: () => wait({ ...settings }),
  set_setting(key: string, value: string): Promise<Settings> {
    switch (key) {
      case "model_tier": settings.model_tier = value; break;
      case "language": settings.language = value || null; break;
      case "device": settings.device = value as Settings["device"]; break;
      case "diarize_threshold": settings.diarize_threshold = value ? Number(value) : null; break;
      case "ffmpeg_path": settings.ffmpeg_path = value || null; break;
      case "ffprobe_path": settings.ffprobe_path = value || null; break;
      case "cache_dir": settings.cache_dir = value || null; break;
      case "autostart": settings.autostart = value === "1"; break;
      case "close_to_tray": settings.close_to_tray = value === "1"; break;
      case "ask_speak_answers": settings.ask_speak_answers = value === "1"; break;
      case "tts_voice_id": settings.tts_voice_id = value as TtsVoiceId; break;
      case "first_run_complete": settings.first_run_complete = value === "1"; break;
    }
    return wait({ ...settings });
  },
  list_models: () => wait(models.map((m) => ({ ...m }))),
  detected_device: () => wait<Resolved>("gpu"),
  disk_usage: () => wait<DiskUsage>({ models_bytes: 1_624_000_000, cache_bytes: 412_000_000 }),
  system_stats(): Promise<SystemStats> {
    // a slow wander rather than random noise, so the meters look like real telemetry
    mockLoad = (mockLoad + 0.17) % 1;
    const wave = (offset: number) => 0.25 + 0.35 * (1 + Math.sin((mockLoad + offset) * Math.PI * 2)) / 2;
    return wait<SystemStats>({
      cpu: {
        usage: wave(0),
        cores: Array.from({ length: 12 }, (_, i) => wave(i / 7)),
        load1: 2.4,
        mem_used: 11_500_000_000,
        mem_total: 32_000_000_000,
        temp_c: Math.round(42 + wave(0) * 35),
        watts: Math.round(18 + wave(0) * 60),
      },
      gpu: {
        name: "AMD Radeon RX 6750 XT",
        usage: wave(0.3),
        vram_used: 6_787_919_872,
        vram_total: 12_868_124_672,
        temp_c: 59,
        watts: 156,
      },
      device: "gpu",
      jobs_active: 1,
      jobs_queued: 2,
    });
  },
  support_models: (): Promise<SupportModels> =>
    wait({ ready: supportReady, missing_bytes: supportReady ? 0 : 35_159_175 }),
  model_download_status: (): Promise<ModelDownloadProgress[]> => wait([]),
  download_support_models() {
    if (supportReady) {
      emit("model_download_progress", { model: SUPPORT_MODELS, pct: 1, phase: "done" });
      return wait(undefined);
    }
    let pct = 0;
    clearInterval(downloads.get(SUPPORT_MODELS));
    downloads.set(SUPPORT_MODELS, setInterval(() => {
      pct = Math.min(0.999, pct + 0.2);
      if (pct < 0.999) {
        emit("model_download_progress", { model: SUPPORT_MODELS, pct, phase: "downloading" });
        return;
      }
      clearInterval(downloads.get(SUPPORT_MODELS));
      downloads.delete(SUPPORT_MODELS);
      supportReady = true;
      emit("model_download_progress", { model: SUPPORT_MODELS, pct: 1, phase: "done" });
    }, 250));
    return wait(undefined);
  },
  download_model(tier: string) {
    const m = models.find((x) => x.tier === tier);
    if (!m) return wait(undefined);
    // already on disk = instant done, same as the real `ensure`
    if (m.downloaded) {
      emit("model_download_progress", { model: tier, pct: 1, phase: "done" });
      return wait(undefined);
    }
    let pct = 0;
    clearInterval(downloads.get(tier));
    downloads.set(tier, setInterval(() => {
      pct = Math.min(0.999, pct + 0.05);
      if (pct < 0.999) {
        emit("model_download_progress", { model: tier, pct, phase: "downloading" });
        return;
      }
      clearInterval(downloads.get(tier));
      downloads.delete(tier);
      // flipped before the terminal event — pct 1 promises the file is there
      m.downloaded = true;
      emit("model_download_progress", { model: tier, pct: 1, phase: "done" });
    }, 250));
    return wait(undefined);
  },
  cancel_model_download(tier: string) {
    if (!downloads.has(tier)) return wait(undefined);
    clearInterval(downloads.get(tier));
    downloads.delete(tier);
    emit("model_download_progress", { model: tier, pct: 0, phase: "done", error: "cancelled" });
    return wait(undefined);
  },
  tts_voice_status: (): Promise<TtsVoiceStatus> => wait(mockVoiceStatus(settings.tts_voice_id)),
  tts_voice_catalog: (): Promise<TtsVoiceStatus[]> => wait(MOCK_VOICES.map((voice) => mockVoiceStatus(voice.voice_id))),
  download_tts_voice(voiceId: TtsVoiceId) {
    const downloadId = ttsVoiceDownloadId(voiceId);
    if (ttsVoiceInstalled.has(voiceId)) {
      emit("model_download_progress", { model: downloadId, pct: 1, phase: "done" });
      return wait(undefined);
    }
    let pct = 0;
    clearInterval(downloads.get(downloadId));
    downloads.set(downloadId, setInterval(() => {
      pct = Math.min(0.999, pct + 0.1);
      if (pct < 0.999) {
        emit("model_download_progress", { model: downloadId, pct, phase: "downloading" });
        return;
      }
      clearInterval(downloads.get(downloadId));
      downloads.delete(downloadId);
      ttsVoiceInstalled.add(voiceId);
      emit("model_download_progress", { model: downloadId, pct: 1, phase: "done" });
    }, 250));
    return wait(undefined);
  },
  cancel_tts_voice_download(voiceId: TtsVoiceId) {
    const downloadId = ttsVoiceDownloadId(voiceId);
    clearInterval(downloads.get(downloadId));
    downloads.delete(downloadId);
    emit("model_download_progress", {
      model: downloadId,
      pct: 0,
      phase: "done",
      error: "cancelled",
    });
    return wait(undefined);
  },
  remove_tts_voice(voiceId: TtsVoiceId) {
    ttsVoiceInstalled.delete(voiceId);
    if (settings.tts_voice_id === voiceId) settings.ask_speak_answers = false;
    return wait(undefined);
  },
  tts_warm() {
    if (!ttsVoiceInstalled.has(settings.tts_voice_id)) return Promise.reject(new Error("speech voice is not downloaded"));
    emit("tts_event", { type: "ready" });
    return wait(undefined);
  },
  tts_speak(input: TtsSpeakInput) {
    if (!ttsVoiceInstalled.has(settings.tts_voice_id)) return Promise.reject(new Error("speech voice is not downloaded"));
    window.setTimeout(() => {
      emit("tts_event", {
        type: "audio",
        request_id: input.request_id,
        sequence: 0,
        samples: new Float32Array(2_205),
        sample_rate: 22_050,
      });
      emit("tts_event", { type: "done", request_id: input.request_id });
    }, 50);
    return wait(undefined);
  },
  tts_stop() {
    return wait(undefined);
  },
  clear_cache: () => wait(undefined),
  get_log_dir: () => wait("/home/naresh/.local/state/unottr/logs"),
  export_transcript: (_id: number, _format: string, _dest: string) => wait(undefined),
  copy_transcript: (_id: number, _format: string) => wait(undefined),
  open_in_default_player: (_id: number) => wait(undefined),

  // ------------------------------------------------------------------ ai overview

  person_set_me(id: number | null) {
    for (const p of people) p.is_me = p.id === id;
    return wait(undefined);
  },
  person_set_role(id: number, role: string) {
    const p = people.find((x) => x.id === id);
    if (p) p.role = role || null;
    return wait(undefined);
  },
  overview_get(recording_id: number): Promise<OverviewPayload> {
    if (recording_id !== 9001) return wait({ overview: null, tasks: [] });
    return wait({ overview: { ...overview }, tasks: overviewTasks.map((t) => ({ ...t })) });
  },
  overview_generate(recording_id: number): Promise<OverviewPayload> {
    if (recording_id !== 9001) return wait({ overview: null, tasks: [] }, 1500);
    overview.status = "running";
    emit("overview_changed", { recording_id });
    return new Promise((resolve) =>
      setTimeout(() => {
        overview.status = "done";
        overview.stale = false;
        overview.stale_reason = null;
        emit("overview_changed", { recording_id });
        resolve({ overview: { ...overview }, tasks: overviewTasks.map((t) => ({ ...t })) });
      }, 2500),
    );
  },
  overview_cancel(recording_id: number) {
    overview.status = "done";
    emit("overview_changed", { recording_id });
    return wait(undefined);
  },
  task_set_status(id: number, status: TaskStatus) {
    const t = overviewTasks.find((x) => x.id === id);
    if (t) t.status = status;
    emit("overview_changed", { recording_id: 9001 });
    return wait(undefined);
  },
  task_update(id: number, patch: { text?: string; owner_speaker_id?: number | null; due_date?: string | null }) {
    const t = overviewTasks.find((x) => x.id === id);
    if (t) {
      Object.assign(t, patch);
      t.user_edited = true;
      if (patch.owner_speaker_id !== undefined) {
        const s = speakers9001.find((x) => x.id === patch.owner_speaker_id);
        t.owner_name = s?.display_name ?? s?.label ?? null;
        t.is_mine = s?.person_id === 1;
      }
    }
    emit("overview_changed", { recording_id: 9001 });
    return wait(undefined);
  },
  ai_settings_get: () => wait({ ...aiSettings }),
  ai_settings_set(patch: { pseudonymize?: boolean; fallback_connection_id?: number | null }): Promise<AiSettings> {
    if (patch.pseudonymize !== undefined) aiSettings.pseudonymize = patch.pseudonymize;
    if (patch.fallback_connection_id !== undefined) aiSettings.fallback_connection_id = patch.fallback_connection_id;
    return wait({ ...aiSettings });
  },
  ai_presets: () => wait(aiPresets),
  ai_detect_agents: () => wait([
    { preset: "claude-code", label: "Claude Code", executable_path: "/home/user/.local/bin/claude", installed: true, beta: false, supported: true, detail: "Installed and ready to test." },
    { preset: "codex-cli", label: "Codex CLI", executable_path: null, installed: false, beta: true, supported: true, detail: "Not found" },
  ]),
  ai_connections_list: () => wait(aiConnections.map((c) => ({ ...c }))),
  ai_connection_save(input: AiConnectionInput): Promise<AiConnection> {
    const found = aiConnections.find((c) => c.id === input.id);
    const target = found ?? { ...aiConnections[0], id: aiConnections.length + 1, active: false };
    Object.assign(target, {
      label: input.label ?? target.label,
      preset: input.preset ?? target.preset,
      kind: input.preset?.endsWith("-cli") || input.preset === "claude-code" ? "cli" : target.kind,
      base_url: input.base_url ?? target.base_url,
      executable_path: input.executable_path ?? target.executable_path,
      subscription_managed: input.preset?.endsWith("-cli") || input.preset === "claude-code" ? true : target.subscription_managed,
      active_model: input.active_model !== undefined ? input.active_model : target.active_model,
      consented: input.consented ?? target.consented,
      key_set: input.key !== undefined ? input.key.length > 0 : target.key_set,
    });
    if (!found) aiConnections.push(target);
    return wait({ ...target });
  },
  ai_connection_delete(id: number): Promise<AiConnection[]> {
    const i = aiConnections.findIndex((c) => c.id === id);
    if (i >= 0) aiConnections.splice(i, 1);
    return wait(aiConnections.map((c) => ({ ...c })));
  },
  ai_connection_activate(id: number): Promise<AiConnection[]> {
    for (const c of aiConnections) c.active = c.id === id;
    aiSettings.active_connection_id = id;
    return wait(aiConnections.map((c) => ({ ...c })));
  },
  ai_connection_test: (id: number): Promise<ProbeResult> => {
    const conn = aiConnections.find((c) => c.id === id);
    return wait(conn?.probe ?? { ok: false, rungs: [], strategy: null, models: [], model: null }, 900);
  },
  ai_models_fetch: (q: { id?: number }) =>
    wait(aiConnections.find((c) => c.id === q.id)?.models ?? ["qwen3:8b", "llama3.2:3b"], 400),
  ai_detect_local: () => wait([{ preset: "ollama", base_url: "http://localhost:11434/v1", models: ["qwen3:8b"] }], 200),
  ai_normalize_url: (base_url: string) => wait(base_url.replace(/\/+$/, "")),
};

const aiSettings: AiSettings = { active_connection_id: 1, fallback_connection_id: null, pseudonymize: false };

const aiPresets: AiPreset[] = [
  { id: "ollama", label: "Ollama", kind: "http", base_url: "http://localhost:11434/v1", wire: "openai", key_required: false, docs_url: null, local: true, executable: null, beta: false },
  { id: "openai", label: "OpenAI", kind: "http", base_url: "https://api.openai.com/v1", wire: "openai", key_required: true, docs_url: null, local: false, executable: null, beta: false },
  { id: "custom", label: "Other (OpenAI-compatible)", kind: "http", base_url: "", wire: "openai", key_required: false, docs_url: null, local: false, executable: null, beta: false },
];

const aiConnections: AiConnection[] = [
  {
    id: 1,
    label: "Ollama",
    preset: "ollama",
    kind: "http",
    wire: "openai",
    base_url: "http://localhost:11434/v1",
    executable_path: null,
    subscription_managed: false,
    beta: false,
    key_set: false,
    key_storage: "none",
    active_model: "qwen3:8b",
    models: ["qwen3:8b", "llama3.2:3b"],
    models_fetched_at: 1787240909,
    strategy: "json_mode",
    context_tokens: 32768,
    timeout_ms: null,
    price_in_usd: null,
    price_out_usd: null,
    consented: true,
    spend_cents: 0,
    local: true,
    probe: {
      ok: true,
      rungs: [
        { step: "reachable", ok: true, detail: "localhost:11434" },
        { step: "authorized", ok: true, detail: "2 models" },
        { step: "responds", ok: true, detail: "qwen3:8b" },
        { step: "structured", ok: true, detail: "JSON mode" },
      ],
      strategy: "json_mode",
      models: ["qwen3:8b", "llama3.2:3b"],
      model: "qwen3:8b",
    },
    probed_at: 1787240909,
    active: true,
  },
];

// One finished overview, so the tab is reviewable with no key configured.
const overview: Overview = {
  recording_id: 9001,
  status: "done",
  error: null,
  error_kind: null,
  model: "qwen3:8b",
  provider: "Ollama",
  role_used: "Engineering manager",
  title: "Q4 roadmap review",
  tldr:
    "Priya opened the quarterly roadmap review and walked the team through search latency, " +
    "which has regressed since the index rebuild. The team agreed to cut the reranker from " +
    "the Q4 scope and ship the latency fix first.",
  sections: [
    {
      heading: "Search latency regression",
      start_ms: 1360,
      end_ms: 7800,
      bullets: [
        { text: "p95 search latency has doubled since the index rebuild.", segment_id: 1, start_ms: 1360, frame_url: "unottr://frame/9001/1360" },
        { text: "The numbers were pulled the morning of the meeting, so they are current.", segment_id: 2, start_ms: 4200, frame_url: "unottr://frame/9001/4200" },
      ],
    },
    {
      heading: "Q4 scope",
      start_ms: 7800,
      end_ms: 11200,
      bullets: [
        { text: "The reranker slips to Q1 so the latency fix can ship alone.", segment_id: 3, start_ms: 7800, frame_url: "unottr://frame/9001/7800" },
      ],
    },
  ],
  decisions: [
    { text: "Cut the reranker from Q4 and ship the latency fix first.", segment_id: 3, start_ms: 7800, frame_url: "unottr://frame/9001/7800" },
  ],
  tokens_in: 8420,
  tokens_out: 1160,
  updated_at: 1765400000,
  stale: false,
  stale_reason: null,
};

const overviewTasks: Task[] = [
  { id: 1, recording_id: 9001, text: "Write up the latency regression and circulate it before Friday.",
    owner_speaker_id: 9101, owner_name: "Priya", is_mine: true, start_ms: 1360,
    due_raw: "before Friday", due_date: "2026-08-21", status: "open", user_edited: false },
  { id: 2, recording_id: 9001, text: "Re-run the search benchmarks against the rebuilt index.",
    owner_speaker_id: 9102, owner_name: "Speaker 2", is_mine: false, start_ms: 4200,
    due_raw: null, due_date: null, status: "open", user_edited: false },
  { id: 3, recording_id: 9001, text: "Move the reranker epic to the Q1 board.",
    owner_speaker_id: null, owner_name: null, is_mine: false, start_ms: 7800,
    due_raw: "next sprint", due_date: null, status: "done", user_edited: false },
];

const settings: Settings = {
  model_tier: "auto",
  language: null,
  device: "auto",
  diarize_threshold: null,
  ffmpeg_path: null,
  ffprobe_path: null,
  cache_dir: null,
  autostart: false,
  close_to_tray: true,
  ask_speak_answers: true,
  tts_voice_id: "en_US-lessac-medium",
  tray_available: true,
  first_run_complete: true,
  ffmpeg_ok: true,
};

const models: ModelInfo[] = [
  {
    tier: "turbo", name: "large-v3-turbo", size: 1_624_000_000, downloaded: true,
    recommended: true, recovery: false,
  },
  {
    tier: "medium", name: "medium", size: 1_530_000_000, downloaded: false,
    recommended: false, recovery: false,
  },
  {
    tier: "small", name: "small", size: 488_000_000, downloaded: false,
    recommended: false, recovery: true,
  },
];

let supportReady = false;

const downloads = new Map<string, ReturnType<typeof setInterval>>();

let mockLoad = 0;
const MOCK_VOICES: Array<Omit<TtsVoiceStatus, "state" | "installed_bytes">> = [
  { voice_id: "en_US-norman-medium", display_name: "Norman", language: "English (US)", download_bytes: 67_203_672 },
  { voice_id: "en_US-ljspeech-medium", display_name: "LJSpeech", language: "English (US)", download_bytes: 67_169_893 },
  { voice_id: "en_US-lessac-medium", display_name: "Lessac", language: "English (US)", download_bytes: 67_230_653 },
];
const ttsVoiceInstalled = new Set<TtsVoiceId>();

function mockVoiceStatus(voiceId: TtsVoiceId): TtsVoiceStatus {
  const voice = MOCK_VOICES.find((item) => item.voice_id === voiceId) ?? MOCK_VOICES[0];
  const installed = ttsVoiceInstalled.has(voice.voice_id);
  return {
    ...voice,
    state: installed ? "installed" : "missing",
    installed_bytes: installed ? 81_529_932 : 0,
  };
}

// A tiny event bus so the mock can push the same events the main process will.
type Payloads = {
  ask_progress: AskProgress;
  backfill_progress: BackfillProgress;
  job_progress: JobProgress;
  incoming_file_progress: IncomingFileProgress;
  job_done: JobDone;
  job_failed: JobFailed;
  recording_discovered: RecordingDiscovered;
  transcript_changed: TranscriptChanged;
  model_download_progress: ModelDownloadProgress;
  overview_changed: OverviewChanged;
  overview_progress: OverviewProgress;
  probe_progress: ProbeProgress;
  tts_event: TtsEvent;
};

const subscribers: { [K in keyof Payloads]: Set<(p: Payloads[K]) => void> } = {
  ask_progress: new Set(),
  backfill_progress: new Set(),
  job_progress: new Set(),
  incoming_file_progress: new Set(),
  job_done: new Set(),
  job_failed: new Set(),
  recording_discovered: new Set(),
  transcript_changed: new Set(),
  model_download_progress: new Set(),
  overview_changed: new Set(),
  overview_progress: new Set(),
  probe_progress: new Set(),
  tts_event: new Set(),
};

function emit<K extends keyof Payloads>(event: K, payload: Payloads[K]): void {
  for (const cb of subscribers[event]) cb(payload);
}

function subscribe<K extends keyof Payloads>(event: K) {
  return (cb: (p: Payloads[K]) => void): () => void => {
    subscribers[event].add(cb);
    return () => {
      subscribers[event].delete(cb);
    };
  };
}

export const mockEvents = {
  ask_progress: subscribe("ask_progress"),
  backfill_progress: subscribe("backfill_progress"),
  job_progress(cb: (p: JobProgress) => void) {
    startTicking();
    return subscribe("job_progress")(cb);
  },
  incoming_file_progress: subscribe("incoming_file_progress"),
  job_done: subscribe("job_done"),
  job_failed: subscribe("job_failed"),
  recording_discovered: subscribe("recording_discovered"),
  transcript_changed: subscribe("transcript_changed"),
  model_download_progress: subscribe("model_download_progress"),
  overview_changed: subscribe("overview_changed"),
  overview_progress: subscribe("overview_progress"),
  probe_progress: subscribe("probe_progress"),
  tts_event: subscribe("tts_event"),
};

// Fake progress for recording 9002 so the live progress bar has something to render.
// Starts with the first subscriber and never restarts — one stream, however many listeners.
let ticking = false;
function startTicking(): void {
  if (ticking) return;
  ticking = true;
  let pct = 12 / 44;
  const t = setInterval(() => {
    pct = Math.min(1, pct + 0.02);
    emit("job_progress", {
      recording_id: 9002,
      stage: "transcribing",
      pct,
      phase: null,
      eta_ms: Math.round((1 - pct) * 9 * 60_000) + 90_000,
      mode: "full",
    });
    if (pct >= 1) {
      clearInterval(t);
      emit("job_done", { recording_id: 9002 });
    }
  }, 500);
}
