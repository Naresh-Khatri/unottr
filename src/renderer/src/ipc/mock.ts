// Zero-backend mock of the IPC surface, matching docs/plan/05-ipc-contract.md.
// Carried over from phase 05; 08.1 runs the whole renderer on it while the main process
// has no data layer. 08.2 flips USE_MOCK back off.

import type {
  AiConnection,
  AiConnectionInput,
  AiPreset,
  AiSettings,
  ProbeResult,
  BackfillEstimate,
  DiskUsage,
  JobDone,
  JobFailed,
  JobProgress,
  ModelDownloadProgress,
  ModelInfo,
  Overview,
  OverviewChanged,
  OverviewProgress,
  OverviewPayload,
  Person,
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
  WatchFolder,
} from "./types";

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
    filename: "2025-10-06 roadmap-review.mp4", title: "Q4 roadmap trade-offs", recorded_at: 1759754411,
    duration_ms: 2130000, status: "done", stage_detail: null, error: null,
    speaker_count: 2, available: true, has_video: true },
  { id: 9002, path: "/home/naresh/fixtures/2026-08-18 standup.mp4",
    filename: "2026-08-18 standup.mp4", title: null, recorded_at: 1765000332,
    duration_ms: 1980000, status: "transcribing", stage_detail: "chunk 12/44",
    error: null, speaker_count: 0, available: true, has_video: true },
  { id: 9003, path: "/home/naresh/fixtures/2025-10-12 interrupted.mp4",
    filename: "2025-10-12 interrupted.mp4", title: null, recorded_at: 1760276883,
    duration_ms: null, status: "failed", stage_detail: null, error: "Truncated",
    speaker_count: 0, available: false, has_video: false },
];

let folders: WatchFolder[] = [
  { id: 1, path: "/home/naresh", track_rule: "auto", enabled: true },
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
  list_recordings(filter?: RecordingFilter, sort?: RecordingSort) {
    let rows = recordings.slice();
    if (filter?.status) rows = rows.filter((r) => r.status === filter.status);
    if (filter?.available !== undefined)
      rows = rows.filter((r) => r.available === filter.available);
    if (sort) {
      const dir = sort.dir === "asc" ? 1 : -1;
      rows.sort((a, b) => {
        const av = a[sort.by] ?? 0, bv = b[sort.by] ?? 0;
        return av < bv ? -dir : av > bv ? dir : 0;
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
    emit("job_progress", { recording_id, stage: "diarizing", pct: 0.4, eta_ms: 8000 });
    setTimeout(() => {
      markSpeakersStale(recording_id);
      emit("job_done", { recording_id });
    }, 1500);
    return wait(undefined);
  },

  list_people: () => wait(people.slice()),
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
  download_model(tier: string) {
    const m = models.find((x) => x.tier === tier);
    if (!m) return wait(undefined);
    let pct = 0;
    clearInterval(downloads.get(tier));
    downloads.set(tier, setInterval(() => {
      pct = Math.min(1, pct + 0.05);
      emit("model_download_progress", { model: tier, pct });
      if (pct >= 1) {
        clearInterval(downloads.get(tier));
        downloads.delete(tier);
        m.downloaded = true;
      }
    }, 250));
    return wait(undefined);
  },
  cancel_model_download(tier: string) {
    clearInterval(downloads.get(tier));
    downloads.delete(tier);
    return wait(undefined);
  },
  clear_cache: () => wait(undefined),
  get_log_dir: () => wait("/home/naresh/.local/state/unottr/logs"),
  export_transcript: (_id: number, _format: string, _dest: string) => wait(undefined),
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
  ai_settings_set(patch: { pseudonymize?: boolean }): Promise<AiSettings> {
    if (patch.pseudonymize !== undefined) aiSettings.pseudonymize = patch.pseudonymize;
    return wait({ ...aiSettings });
  },
  ai_presets: () => wait(aiPresets),
  ai_connections_list: () => wait(aiConnections.map((c) => ({ ...c }))),
  ai_connection_save(input: AiConnectionInput): Promise<AiConnection> {
    const found = aiConnections.find((c) => c.id === input.id);
    const target = found ?? { ...aiConnections[0], id: aiConnections.length + 1, active: false };
    Object.assign(target, {
      label: input.label ?? target.label,
      base_url: input.base_url ?? target.base_url,
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

const aiSettings: AiSettings = { active_connection_id: 1, pseudonymize: false };

const aiPresets: AiPreset[] = [
  { id: "ollama", label: "Ollama", base_url: "http://localhost:11434/v1", wire: "openai", key_required: false, docs_url: null, local: true },
  { id: "openai", label: "OpenAI", base_url: "https://api.openai.com/v1", wire: "openai", key_required: true, docs_url: null, local: false },
  { id: "custom", label: "Other (OpenAI-compatible)", base_url: "", wire: "openai", key_required: false, docs_url: null, local: false },
];

const aiConnections: AiConnection[] = [
  {
    id: 1,
    label: "Ollama",
    preset: "ollama",
    wire: "openai",
    base_url: "http://localhost:11434/v1",
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
  tray_available: true,
  first_run_complete: true,
  ffmpeg_ok: true,
};

const models: ModelInfo[] = [
  { tier: "turbo", name: "large-v3-turbo", size: 1_624_000_000, downloaded: true },
  { tier: "medium", name: "medium", size: 1_530_000_000, downloaded: false },
  { tier: "small", name: "small", size: 488_000_000, downloaded: false },
];

const downloads = new Map<string, ReturnType<typeof setInterval>>();

let mockLoad = 0;

// A tiny event bus so the mock can push the same events the main process will.
type Payloads = {
  job_progress: JobProgress;
  job_done: JobDone;
  job_failed: JobFailed;
  recording_discovered: RecordingDiscovered;
  model_download_progress: ModelDownloadProgress;
  overview_changed: OverviewChanged;
  overview_progress: OverviewProgress;
};

const subscribers: { [K in keyof Payloads]: Set<(p: Payloads[K]) => void> } = {
  job_progress: new Set(),
  job_done: new Set(),
  job_failed: new Set(),
  recording_discovered: new Set(),
  model_download_progress: new Set(),
  overview_changed: new Set(),
  overview_progress: new Set(),
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
  job_progress(cb: (p: JobProgress) => void) {
    startTicking();
    return subscribe("job_progress")(cb);
  },
  job_done: subscribe("job_done"),
  job_failed: subscribe("job_failed"),
  recording_discovered: subscribe("recording_discovered"),
  model_download_progress: subscribe("model_download_progress"),
  overview_changed: subscribe("overview_changed"),
  overview_progress: subscribe("overview_progress"),
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
      eta_ms: Math.round((1 - pct) * 9 * 60_000) + 90_000,
    });
    if (pct >= 1) {
      clearInterval(t);
      emit("job_done", { recording_id: 9002 });
    }
  }, 500);
}
