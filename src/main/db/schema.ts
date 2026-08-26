// Greenfield port of crates/unottr-core/src/db/migrations.rs. V1+V2+V4 are folded in —
// V3 was a one-time status rewrite for pre-contract rows and has nothing to rewrite here.
// segments_fts and its three triggers live in drizzle/0001_fts.sql: drizzle-kit cannot
// introspect or generate an fts5 virtual table, and `push` would propose dropping them.

import { sql } from "drizzle-orm";
import { blob, index, integer, real, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

/** The frozen state machine (05-ipc-contract.md). */
export const STATUSES = [
  "discovered",
  "probing",
  "extracting",
  "transcribing",
  "diarizing",
  "merging",
  "done",
  "failed",
] as const;

export type Status = (typeof STATUSES)[number];

export const TERMINAL: Status[] = ["done", "failed"];

export const recordings = sqliteTable(
  "recordings",
  {
    id: integer("id").primaryKey(),
    path: text("path").notNull().unique(),
    fpSize: integer("fp_size").notNull(),
    fpHead: blob("fp_head", { mode: "buffer" }).notNull(),
    fpTail: blob("fp_tail", { mode: "buffer" }).notNull(),
    container: text("container"),
    durationMs: integer("duration_ms"),
    recordedAt: integer("recorded_at"),
    status: text("status").$type<Status>().notNull(),
    stageDetail: text("stage_detail"),
    /** typed-error slug, set when status = 'failed' */
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    lastChunkIdx: integer("last_chunk_idx"),
    available: integer("available").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    /** sticky "whisper OOM'd on the gpu for this file, use cpu" flag (decision #19) */
    forceCpu: integer("force_cpu").notNull().default(0),
    /** user-set; outranks `aiTitle`, which outranks the filename (decision #32) */
    title: text("title"),
    aiTitle: text("ai_title"),
    /** bumped by every speaker fix (merge, reassign, re-diarize) — what makes an overview
     *  written against the old cast knowably stale (decision #50) */
    speakersVersion: integer("speakers_version").notNull().default(0),
    /** bumped whenever displayed transcript text changes */
    transcriptVersion: integer("transcript_version").notNull().default(0),
  },
  (t) => [
    index("idx_recordings_status").on(t.status),
    index("idx_recordings_fp").on(t.fpSize, t.fpHead),
  ],
);

/**
 * A voice that outlives one recording. `embedding` is the running mean of every speaker
 * centroid a user has confirmed as this person (unit length, `samples` of them), which is
 * what the next recording's clusters get matched against.
 */
export const people = sqliteTable("people", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  /** case-folded name — the real uniqueness key, so "Priya" and "priya" are one person */
  nameKey: text("name_key").notNull().unique(),
  /** null until the first confirmed speaker enrolls one; never crosses ipc */
  embedding: blob("embedding", { mode: "buffer" }),
  samples: integer("samples").notNull().default(0),
  /** at most one row set; enforced by the setter, not a constraint (decision #31) */
  isMe: integer("is_me").notNull().default(0),
  /** free text — "Developer", "QA lead". Frames the task list, never filters it. */
  role: text("role"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const speakers = sqliteTable(
  "speakers",
  {
    id: integer("id").primaryKey(),
    recordingId: integer("recording_id")
      .notNull()
      .references(() => recordings.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    /** a name with no voiceprint behind it: this recording only. `person_id` is the global one. */
    displayName: text("display_name"),
    personId: integer("person_id").references(() => people.id, { onDelete: "set null" }),
    /** never crosses ipc */
    embedding: blob("embedding", { mode: "buffer" }),
  },
  (t) => [unique().on(t.recordingId, t.label), index("idx_speakers_person").on(t.personId)],
);

export const segments = sqliteTable(
  "segments",
  {
    id: integer("id").primaryKey(),
    recordingId: integer("recording_id")
      .notNull()
      .references(() => recordings.id, { onDelete: "cascade" }),
    chunkIdx: integer("chunk_idx").notNull(),
    startMs: integer("start_ms").notNull(),
    endMs: integer("end_ms").notNull(),
    text: text("text").notNull(),
    /** Whisper's text before terminology rules. Set only after a rule changes this segment. */
    rawText: text("raw_text"),
    /** json Word[] */
    words: text("words"),
    speakerId: integer("speaker_id").references(() => speakers.id, { onDelete: "set null" }),
    /** back-pointer to the whisper row diarization split, so re-running can't split twice */
    splitOf: integer("split_of"),
  },
  (t) => [
    index("idx_segments_recording").on(t.recordingId, t.startMs),
    index("idx_segments_chunk").on(t.recordingId, t.chunkIdx),
    index("idx_segments_split").on(t.recordingId, t.splitOf),
  ],
);

export const watchFolders = sqliteTable("watch_folders", {
  id: integer("id").primaryKey(),
  path: text("path").notNull().unique(),
  /** "auto" or a JSON-serialized TrackRule — stored verbatim, parsed at the call site */
  trackRule: text("track_rule").notNull().default("auto"),
  enabled: integer("enabled").notNull().default(1),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/** Literal corrections applied after diarization, when the final segment boundaries exist. */
export const terminologyRules = sqliteTable(
  "terminology_rules",
  {
    id: integer("id").primaryKey(),
    source: text("source").notNull(),
    /** match-semantics key: case-folded only when this rule ignores case */
    sourceKey: text("source_key").notNull(),
    replacement: text("replacement").notNull(),
    caseSensitive: integer("case_sensitive").notNull().default(0),
    wholeWord: integer("whole_word").notNull().default(1),
    enabled: integer("enabled").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [unique().on(t.sourceKey, t.wholeWord)],
);

/**
 * What a stage costs *on this machine*: wall ms per ms of source audio, learned from jobs
 * that finished. `key` is `stage:device:model`, the three things the number depends on —
 * transcription on a gpu and on 12 cpu threads differ by 30×, so one global number would be
 * useless. Feeds the eta only; losing the table costs accuracy, not correctness.
 */
export const stageRates = sqliteTable("stage_rates", {
  key: text("key").primaryKey(),
  rate: real("rate").notNull(),
  samples: integer("samples").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
});

/** The overview's own lifecycle (decision #27). `recordings.status` never enters an AI state. */
export const OVERVIEW_STATUSES = ["pending", "running", "done", "failed"] as const;
export type OverviewStatus = (typeof OVERVIEW_STATUSES)[number];

/** Why a call failed, so the ui can say whether "retry" is even the right advice. */
export const ERROR_KINDS = [
  "auth",
  "rate_limit",
  "network",
  "validation",
  "aborted",
  "timeout",
  "unreachable",
  "too_long",
  "unknown",
] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

/**
 * One row per recording, updated in place — regeneration overwrites (prose is ~1.4¢ to remake).
 * `sections` and `decisions` are json: nothing queries inside them, and flattening them into
 * tables would buy a join for no reader. Tasks are rows because they *are* queried — by
 * status, by owner, and one day across recordings.
 */
export const overviews = sqliteTable("overviews", {
  id: integer("id").primaryKey(),
  recordingId: integer("recording_id")
    .notNull()
    .unique()
    .references(() => recordings.id, { onDelete: "cascade" }),
  status: text("status").$type<OverviewStatus>().notNull(),
  error: text("error"),
  errorKind: text("error_kind").$type<ErrorKind>(),
  model: text("model"),
  /** the connection's label at generation time; `model` alone can't name who served it */
  provider: text("provider"),
  /** bumped when prompt.ts changes; what makes an old overview knowably stale */
  promptVersion: integer("prompt_version").notNull().default(0),
  roleUsed: text("role_used"),
  /** `recordings.speakers_version` as it stood when this was generated */
  speakersVersion: integer("speakers_version").notNull().default(0),
  /** `recordings.transcript_version` when this overview was generated */
  transcriptVersion: integer("transcript_version").notNull().default(0),
  title: text("title"),
  tldr: text("tldr"),
  /** json OverviewSection[] */
  sections: text("sections"),
  /** json OverviewBullet[] */
  decisions: text("decisions"),
  tokensIn: integer("tokens_in"),
  tokensOut: integer("tokens_out"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * How a model is made to emit our schema, cheapest-first. Probed once per connection and
 * stored, because a 7B local model passes "the endpoint answers" and then fails every real
 * generation — which rung it reached is the only honest answer to "is this set up?".
 */
export const STRATEGIES = ["native", "json_mode", "prompted"] as const;
export type Strategy = (typeof STRATEGIES)[number];

/** Request shape. Never sniffed from a url — /v1/messages is indistinguishable from /v1. */
export const WIRES = ["openai", "anthropic", "mistral"] as const;
export type Wire = (typeof WIRES)[number];

export const AI_CONNECTION_KINDS = ["http", "cli"] as const;
export type AiConnectionKind = (typeof AI_CONNECTION_KINDS)[number];

/**
 * One endpoint the user has added. The key lives here and nowhere else; `connections.ts` is
 * the only file that reads it, and it never crosses ipc. `spend_cents` is per-connection
 * because a local model's is always 0 and a cloud one's is nobody else's business.
 */
export const aiConnections = sqliteTable("ai_connections", {
  id: integer("id").primaryKey(),
  label: text("label").notNull(),
  /** which entry of PRESETS this came from; "custom" for a hand-typed url */
  preset: text("preset").notNull(),
  kind: text("kind").$type<AiConnectionKind>().notNull().default("http"),
  wire: text("wire").$type<Wire>().notNull(),
  baseUrl: text("base_url").notNull(),
  /** Absolute path, never a shell fragment. Null for HTTP connections. */
  executablePath: text("executable_path"),
  /** safeStorage ciphertext, base64 */
  keyEnc: text("key_enc"),
  /** no keyring on this box, and the user said ok */
  keyPlain: text("key_plain"),
  activeModel: text("active_model"),
  /** json string[] — last successful /models listing, so the dropdown works offline */
  modelsJson: text("models_json"),
  modelsFetchedAt: integer("models_fetched_at"),
  strategy: text("strategy").$type<Strategy>().notNull().default("native"),
  /** what the model can actually hold; drives the pre-flight estimate, not a hard limit */
  contextTokens: integer("context_tokens"),
  /** a 7B on cpu is minutes, not seconds — one global ceiling would fail it every time */
  timeoutMs: integer("timeout_ms"),
  /** USD per million tokens; null = don't estimate spend at all (local models) */
  priceInUsd: real("price_in_usd"),
  priceOutUsd: real("price_out_usd"),
  /** per-connection: consenting to send text to a laptop is not consenting to send it to a cloud */
  consented: integer("consented").notNull().default(0),
  spendCents: real("spend_cents").notNull().default(0),
  /** json ProbeResult — the four-rung ladder's last verdict, shown as a checklist */
  probeJson: text("probe_json"),
  probedAt: integer("probed_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const TASK_STATUSES = ["open", "done", "dismissed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * Owner is a *speaker*, not a person: `people` rows only exist once someone has been named, so
 * a people-keyed owner would be NULL on nearly every task in a fresh library. "Mine" is the
 * join through `speakers.person_id` = the `is_me` person.
 */
export const tasks = sqliteTable(
  "tasks",
  {
    id: integer("id").primaryKey(),
    recordingId: integer("recording_id")
      .notNull()
      .references(() => recordings.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    ownerSpeakerId: integer("owner_speaker_id").references(() => speakers.id, { onDelete: "set null" }),
    startMs: integer("start_ms").notNull(),
    /** the phrase as spoken; kept even when it did not resolve to a date */
    dueRaw: text("due_raw"),
    /** YYYY-MM-DD, or null when it did not parse — a wrongly resolved date is worse than none */
    dueDate: text("due_date"),
    status: text("status").$type<TaskStatus>().notNull().default("open"),
    /** regeneration never touches a row with this set */
    userEdited: integer("user_edited").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("idx_tasks_recording").on(t.recordingId)],
);

/** A saved Ask conversation. Scope is JSON so new filters can be added without a table rewrite. */
export const askThreads = sqliteTable(
  "ask_threads",
  {
    id: integer("id").primaryKey(),
    title: text("title").notNull(),
    scopeJson: text("scope_json").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("idx_ask_threads_updated").on(t.updatedAt)],
);

export const ASK_ROLES = ["user", "assistant"] as const;
export type AskRole = (typeof ASK_ROLES)[number];

/**
 * Assistant payloads contain answer blocks and citation identifiers. Retrieved transcript
 * windows are deliberately not stored; excerpts are resolved again when the thread is read.
 */
export const askMessages = sqliteTable(
  "ask_messages",
  {
    id: integer("id").primaryKey(),
    threadId: integer("thread_id")
      .notNull()
      .references(() => askThreads.id, { onDelete: "cascade" }),
    role: text("role").$type<AskRole>().notNull(),
    text: text("text").notNull(),
    payloadJson: text("payload_json"),
    provider: text("provider"),
    model: text("model"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("idx_ask_messages_thread").on(t.threadId, t.createdAt, t.id)],
);

/**
 * Correlated subquery, not a groupBy join — a recording with no speakers still has to appear.
 * Names written out: drizzle emits interpolated columns unqualified, so `${speakers.recordingId}
 * = ${recordings.id}` would compare two columns of `speakers` and always count 0.
 */
export const speakerCount = sql<number>`(select count(*) from speakers where speakers.recording_id = recordings.id)`;
