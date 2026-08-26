import { basename } from "node:path";
import { asc, desc, eq, like, sql } from "drizzle-orm";
import type {
  AskAnswerBlock,
  AskCitation,
  AskMessage,
  AskScope,
  AskThread,
  AskThreadSummary,
} from "../../shared/ipc";
import type { Db } from "./client";
import { askMessages, askThreads, people, recordings, segments, speakers, tasks } from "./schema";
import { now } from "./recordings";

export interface CitationRef {
  kind: "transcript" | "workspace";
  recordingId: number;
  recordingTitle: string;
  meetingDate: number | null;
  segmentId: number | null;
  taskId: number | null;
  startMs: number;
  transcriptVersion: number;
}

export interface StoredAnswer {
  blocks: { text: string; refs: CitationRef[] }[];
  followUps: string[];
  searchedRecordings: number;
  usedRecordings: number;
}

type MessageRow = typeof askMessages.$inferSelect;

export const emptyScope = (): AskScope => ({
  recording_ids: [],
  person_ids: [],
  date_from: null,
  date_to: null,
});

export function normalizeScope(raw: Partial<AskScope> | null | undefined): AskScope {
  const ids = (value: unknown): number[] =>
    Array.isArray(value)
      ? [...new Set(value.filter((v): v is number => Number.isInteger(v) && v > 0))].sort((a, b) => a - b)
      : [];
  const date = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : null;
  return {
    recording_ids: ids(raw?.recording_ids),
    person_ids: ids(raw?.person_ids),
    date_from: date(raw?.date_from),
    date_to: date(raw?.date_to),
  };
}

export function sameScope(a: AskScope, b: AskScope): boolean {
  return JSON.stringify(normalizeScope(a)) === JSON.stringify(normalizeScope(b));
}

export function createThread(db: Db, scope: AskScope, title = "New question"): number {
  const ts = now();
  return db
    .insert(askThreads)
    .values({ title, scopeJson: JSON.stringify(normalizeScope(scope)), createdAt: ts, updatedAt: ts })
    .returning({ id: askThreads.id })
    .get().id;
}

export function list(db: Db, search = ""): AskThreadSummary[] {
  const rows = db
    .select({
      id: askThreads.id,
      title: askThreads.title,
      scopeJson: askThreads.scopeJson,
      createdAt: askThreads.createdAt,
      updatedAt: askThreads.updatedAt,
      messageCount: sql<number>`(select count(*) from ask_messages where ask_messages.thread_id = ${askThreads.id})`,
    })
    .from(askThreads)
    .where(search.trim() ? like(askThreads.title, `%${search.trim()}%`) : undefined)
    .orderBy(desc(askThreads.updatedAt), desc(askThreads.id))
    .all();
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    scope: parseScope(r.scopeJson),
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    message_count: r.messageCount,
  }));
}

export function get(db: Db, id: number): AskThread | null {
  const thread = db.select().from(askThreads).where(eq(askThreads.id, id)).get();
  if (!thread) return null;
  const rows = db
    .select()
    .from(askMessages)
    .where(eq(askMessages.threadId, id))
    .orderBy(asc(askMessages.createdAt), asc(askMessages.id))
    .all();
  return {
    id: thread.id,
    title: thread.title,
    scope: parseScope(thread.scopeJson),
    created_at: thread.createdAt,
    updated_at: thread.updatedAt,
    message_count: rows.length,
    messages: rows.map((row) => toMessage(db, row)),
  };
}

export function scopeOf(db: Db, id: number): AskScope | null {
  const row = db
    .select({ scopeJson: askThreads.scopeJson })
    .from(askThreads)
    .where(eq(askThreads.id, id))
    .get();
  return row ? parseScope(row.scopeJson) : null;
}

export function history(db: Db, threadId: number): { role: "user" | "assistant"; text: string }[] {
  return db
    .select({ role: askMessages.role, text: askMessages.text })
    .from(askMessages)
    .where(eq(askMessages.threadId, threadId))
    .orderBy(asc(askMessages.createdAt), asc(askMessages.id))
    .all();
}

export function saveExchange(
  db: Db,
  threadId: number,
  question: string,
  answer: StoredAnswer,
  provider: string | null,
  model: string | null,
): void {
  const ts = now();
  const text = answer.blocks.map((b) => b.text).join("\n\n");
  db.transaction((tx) => {
    tx.insert(askMessages)
      .values({ threadId, role: "user", text: question, createdAt: ts })
      .run();
    tx.insert(askMessages)
      .values({
        threadId,
        role: "assistant",
        text,
        payloadJson: JSON.stringify(answer),
        provider,
        model,
        createdAt: ts + 1,
      })
      .run();

    const count = tx
      .select({ count: sql<number>`count(*)` })
      .from(askMessages)
      .where(eq(askMessages.threadId, threadId))
      .get()?.count ?? 0;
    tx.update(askThreads)
      .set({
        ...(count === 2 ? { title: titleFrom(question) } : {}),
        updatedAt: ts,
      })
      .where(eq(askThreads.id, threadId))
      .run();
  });
}

export function rename(db: Db, id: number, raw: string): void {
  const title = raw.trim();
  if (!title) throw new Error("a thread needs a title");
  const result = db.update(askThreads).set({ title, updatedAt: now() }).where(eq(askThreads.id, id)).run();
  if (!result.changes) throw new Error(`thread ${id} not found`);
}

export function remove(db: Db, id: number): void {
  db.delete(askThreads).where(eq(askThreads.id, id)).run();
}

function toMessage(db: Db, row: MessageRow): AskMessage {
  if (row.role === "user") {
    return {
      id: row.id,
      thread_id: row.threadId,
      role: "user",
      text: row.text,
      blocks: [{ text: row.text, citations: [] }],
      follow_ups: [],
      provider: null,
      model: null,
      searched_recordings: 0,
      used_recordings: 0,
      created_at: row.createdAt,
    };
  }

  const stored = parseAnswer(row.payloadJson, row.text);
  return {
    id: row.id,
    thread_id: row.threadId,
    role: "assistant",
    text: row.text,
    blocks: stored.blocks.map(
      (block): AskAnswerBlock => ({
        text: block.text,
        citations: block.refs.map((ref) => resolveCitation(db, ref)),
      }),
    ),
    follow_ups: stored.followUps,
    provider: row.provider,
    model: row.model,
    searched_recordings: stored.searchedRecordings,
    used_recordings: stored.usedRecordings,
    created_at: row.createdAt,
  };
}

function resolveCitation(db: Db, ref: CitationRef): AskCitation {
  if (ref.kind === "workspace" && ref.taskId !== null) {
    const row = db
      .select({
        recordingId: recordings.id,
        title: sql<string | null>`coalesce(${recordings.title}, ${recordings.aiTitle})`,
        path: recordings.path,
        meetingDate: sql<number | null>`coalesce(${recordings.recordedAt}, ${recordings.createdAt})`,
        transcriptVersion: recordings.transcriptVersion,
        text: tasks.text,
        startMs: tasks.startMs,
        speaker: sql<string | null>`coalesce(${people.name}, ${speakers.displayName}, ${speakers.label})`,
      })
      .from(tasks)
      .innerJoin(recordings, eq(recordings.id, tasks.recordingId))
      .leftJoin(speakers, eq(speakers.id, tasks.ownerSpeakerId))
      .leftJoin(people, eq(people.id, speakers.personId))
      .where(eq(tasks.id, ref.taskId))
      .get();
    if (row) {
      return {
        kind: "workspace",
        recording_id: row.recordingId,
        recording_title: row.title ?? (basename(row.path) || row.path),
        meeting_date: row.meetingDate,
        segment_id: null,
        task_id: ref.taskId,
        start_ms: row.startMs,
        speaker: row.speaker,
        excerpt: row.text,
        source_changed: row.transcriptVersion !== ref.transcriptVersion,
        unavailable: false,
      };
    }
  }

  if (ref.segmentId !== null) {
    const row = db
      .select({
        recordingId: recordings.id,
        title: sql<string | null>`coalesce(${recordings.title}, ${recordings.aiTitle})`,
        path: recordings.path,
        meetingDate: sql<number | null>`coalesce(${recordings.recordedAt}, ${recordings.createdAt})`,
        transcriptVersion: recordings.transcriptVersion,
        text: segments.text,
        startMs: segments.startMs,
        speaker: sql<string | null>`coalesce(${people.name}, ${speakers.displayName}, ${speakers.label})`,
      })
      .from(segments)
      .innerJoin(recordings, eq(recordings.id, segments.recordingId))
      .leftJoin(speakers, eq(speakers.id, segments.speakerId))
      .leftJoin(people, eq(people.id, speakers.personId))
      .where(eq(segments.id, ref.segmentId))
      .get();
    if (row) {
      return {
        kind: "transcript",
        recording_id: row.recordingId,
        recording_title: row.title ?? (basename(row.path) || row.path),
        meeting_date: row.meetingDate,
        segment_id: ref.segmentId,
        task_id: null,
        start_ms: row.startMs,
        speaker: row.speaker,
        excerpt: row.text,
        source_changed: row.transcriptVersion !== ref.transcriptVersion,
        unavailable: false,
      };
    }
  }

  return {
    kind: ref.kind,
    recording_id: ref.recordingId,
    recording_title: ref.recordingTitle,
    meeting_date: ref.meetingDate,
    segment_id: ref.segmentId,
    task_id: ref.taskId,
    start_ms: ref.startMs,
    speaker: null,
    excerpt: null,
    source_changed: false,
    unavailable: true,
  };
}

function titleFrom(question: string): string {
  const oneLine = question.replace(/\s+/g, " ").trim();
  if (oneLine.length <= 56) return oneLine;
  return `${oneLine.slice(0, 53).trimEnd()}...`;
}

function parseScope(raw: string): AskScope {
  try {
    return normalizeScope(JSON.parse(raw) as Partial<AskScope>);
  } catch {
    return emptyScope();
  }
}

function parseAnswer(raw: string | null, fallback: string): StoredAnswer {
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as StoredAnswer;
      if (Array.isArray(parsed.blocks) && Array.isArray(parsed.followUps)) {
        return {
          ...parsed,
          searchedRecordings: Number.isFinite(parsed.searchedRecordings) ? parsed.searchedRecordings : 0,
          usedRecordings: Number.isFinite(parsed.usedRecordings) ? parsed.usedRecordings : 0,
        };
      }
    } catch {
      // Old or damaged payloads still render their saved text.
    }
  }
  return {
    blocks: [{ text: fallback, refs: [] }],
    followUps: [],
    searchedRecordings: 0,
    usedRecordings: 0,
  };
}
