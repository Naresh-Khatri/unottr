// The AI overview's persistence. A satellite of a recording: nothing here can move a
// recording's status, and a missing/failed overview leaves the transcript beside it intact.
// `overview_fts` is standalone (no triggers) — `save` is the only writer, so it is the only
// thing that has to keep it in step.

import { basename } from "node:path";
import { asc, eq, inArray, sql } from "drizzle-orm";
import type {
  ErrorKind,
  Overview,
  OverviewBullet,
  OverviewPayload,
  OverviewSection,
  SearchHit,
  Task,
  TaskStatus,
} from "../../shared/ipc";
import { PROMPT_VERSION } from "../ai/prompt";
import type { Db } from "./client";
import { myRole } from "./people";
import { hasVideo } from "./queries";
import { now } from "./recordings";
import { overviews, people, recordings, speakers, tasks } from "./schema";

/** A bullet as stored: no `frame_url`, which is derived per read from the recording id. */
interface StoredBullet {
  text: string;
  segment_id: number;
  start_ms: number;
}

interface StoredSection {
  heading: string;
  start_ms: number;
  end_ms: number;
  bullets: StoredBullet[];
}

/** What `save` writes — already grounded, so every `segment_id` here is known to exist. */
export interface OverviewWrite {
  model: string;
  provider: string;
  roleUsed: string | null;
  title: string;
  tldr: string;
  sections: StoredSection[];
  decisions: StoredBullet[];
  tasks: {
    text: string;
    ownerSpeakerId: number | null;
    startMs: number;
    dueRaw: string | null;
    dueDate: string | null;
  }[];
  tokensIn: number | null;
  tokensOut: number | null;
}

// --------------------------------------------------------------------------------- reads

export function getPayload(db: Db, recordingId: number): OverviewPayload {
  return { overview: get(db, recordingId), tasks: listTasks(db, recordingId) };
}

export function get(db: Db, recordingId: number): Overview | null {
  const row = db.select().from(overviews).where(eq(overviews.recordingId, recordingId)).get();
  if (!row) return null;

  const video = hasVideo(
    db.select({ path: recordings.path }).from(recordings).where(eq(recordings.id, recordingId)).get()?.path ?? "",
  );
  const bullet = (b: StoredBullet): OverviewBullet => ({
    ...b,
    frame_url: video ? `unottr://frame/${recordingId}/${b.start_ms}` : null,
  });

  const sections = parseJson<StoredSection[]>(row.sections, []).map(
    (s): OverviewSection => ({ ...s, bullets: (s.bullets ?? []).map(bullet) }),
  );

  return {
    recording_id: recordingId,
    status: row.status,
    error: row.error,
    error_kind: row.errorKind,
    model: row.model,
    provider: row.provider,
    role_used: row.roleUsed,
    title: row.title,
    tldr: row.tldr,
    sections,
    decisions: parseJson<StoredBullet[]>(row.decisions, []).map(bullet),
    tokens_in: row.tokensIn,
    tokens_out: row.tokensOut,
    updated_at: row.updatedAt,
    stale: row.status === "done" && (row.promptVersion !== PROMPT_VERSION || row.roleUsed !== myRole(db)),
  };
}

export function listTasks(db: Db, recordingId: number): Task[] {
  return db
    .select({
      id: tasks.id,
      recording_id: tasks.recordingId,
      text: tasks.text,
      owner_speaker_id: tasks.ownerSpeakerId,
      owner_name: sql<string | null>`coalesce(${people.name}, ${speakers.displayName}, ${speakers.label})`,
      is_mine: sql<number>`coalesce(${people.isMe}, 0)`,
      start_ms: tasks.startMs,
      due_raw: tasks.dueRaw,
      due_date: tasks.dueDate,
      status: tasks.status,
      user_edited: tasks.userEdited,
    })
    .from(tasks)
    .leftJoin(speakers, eq(speakers.id, tasks.ownerSpeakerId))
    .leftJoin(people, eq(people.id, speakers.personId))
    .where(eq(tasks.recordingId, recordingId))
    .orderBy(asc(tasks.startMs), asc(tasks.id))
    .all()
    .map((t) => ({ ...t, is_mine: t.is_mine !== 0, user_edited: t.user_edited !== 0 }));
}

export function isRunning(db: Db, recordingId: number): boolean {
  const row = db
    .select({ status: overviews.status })
    .from(overviews)
    .where(eq(overviews.recordingId, recordingId))
    .get();
  return row?.status === "running";
}

// -------------------------------------------------------------------------------- writes

export function markRunning(
  db: Db,
  recordingId: number,
  model: string,
  provider: string,
  roleUsed: string | null,
): void {
  const ts = now();
  db.insert(overviews)
    .values({ recordingId, status: "running", model, provider, roleUsed, createdAt: ts, updatedAt: ts })
    .onConflictDoUpdate({
      target: overviews.recordingId,
      // prose from the previous run is left in place: a failed retry should not blank the tab
      set: { status: "running", error: null, errorKind: null, model, provider, roleUsed, updatedAt: ts },
    })
    .run();
}

export function markFailed(db: Db, recordingId: number, error: string, kind: ErrorKind): void {
  db.update(overviews)
    .set({ status: "failed", error, errorKind: kind, updatedAt: now() })
    .where(eq(overviews.recordingId, recordingId))
    .run();
}

/**
 * Land a finished generation. Prose is overwritten (decision #33) but tasks are merged: a task
 * you edited, ticked off or dismissed survives a regenerate, and a freshly suggested one is
 * dropped if a survivor already says the same thing.
 */
export function save(db: Db, recordingId: number, w: OverviewWrite): void {
  db.transaction((tx) => {
    const ts = now();
    tx.update(overviews)
      .set({
        status: "done",
        error: null,
        errorKind: null,
        model: w.model,
        provider: w.provider,
        promptVersion: PROMPT_VERSION,
        roleUsed: w.roleUsed,
        title: w.title,
        tldr: w.tldr,
        sections: JSON.stringify(w.sections),
        decisions: JSON.stringify(w.decisions),
        tokensIn: w.tokensIn,
        tokensOut: w.tokensOut,
        updatedAt: ts,
      })
      .where(eq(overviews.recordingId, recordingId))
      .run();

    // ai_title never outranks a title the user typed, so it is safe to always write
    tx.update(recordings).set({ aiTitle: w.title, updatedAt: ts }).where(eq(recordings.id, recordingId)).run();

    const survivors = tx
      .select({ id: tasks.id, text: tasks.text, status: tasks.status, userEdited: tasks.userEdited })
      .from(tasks)
      .where(eq(tasks.recordingId, recordingId))
      .all()
      .filter((t) => t.userEdited !== 0 || t.status !== "open");

    const keep = new Set(survivors.map((t) => t.id));
    const stale = tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.recordingId, recordingId))
      .all()
      .filter((t) => !keep.has(t.id))
      .map((t) => t.id);
    if (stale.length) tx.delete(tasks).where(inArray(tasks.id, stale)).run();

    const seen = new Set(survivors.map((t) => normalize(t.text)));
    for (const t of w.tasks) {
      const key = normalize(t.text);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      tx.insert(tasks)
        .values({
          recordingId,
          text: t.text,
          ownerSpeakerId: t.ownerSpeakerId,
          startMs: t.startMs,
          dueRaw: t.dueRaw,
          dueDate: t.dueDate,
          status: "open",
          userEdited: 0,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();
    }

    indexFts(tx, recordingId, w);
  });
}

export function setTaskStatus(db: Db, taskId: number, status: TaskStatus): number {
  const row = db
    .update(tasks)
    .set({ status, updatedAt: now() })
    .where(eq(tasks.id, taskId))
    .returning({ recordingId: tasks.recordingId })
    .get();
  if (!row) throw new Error(`no task with id ${taskId}`);
  return row.recordingId;
}

export interface TaskEdit {
  text?: string;
  ownerSpeakerId?: number | null;
  dueDate?: string | null;
}

/** Any hand edit pins the row: `save` will never delete or duplicate it afterwards. */
export function updateTask(db: Db, taskId: number, edit: TaskEdit): number {
  const set: Record<string, unknown> = { userEdited: 1, updatedAt: now() };
  if (edit.text !== undefined) {
    const text = edit.text.trim();
    if (!text) throw new Error("a task needs text");
    set.text = text;
  }
  if (edit.ownerSpeakerId !== undefined) set.ownerSpeakerId = edit.ownerSpeakerId;
  if (edit.dueDate !== undefined) set.dueDate = edit.dueDate;

  const row = db
    .update(tasks)
    .set(set)
    .where(eq(tasks.id, taskId))
    .returning({ recordingId: tasks.recordingId })
    .get();
  if (!row) throw new Error(`no task with id ${taskId}`);
  return row.recordingId;
}

/**
 * A generation that was in flight when the app died left a `running` row nothing will ever
 * finish. There is no resume for it — the call is not checkpointable and costs money — so it
 * is failed at startup and the user decides whether to spend again.
 */
export function sweepRunning(db: Db): number {
  return db
    .update(overviews)
    .set({ status: "failed", error: "interrupted", errorKind: "aborted", updatedAt: now() })
    .where(eq(overviews.status, "running"))
    .run().changes;
}

// ----------------------------------------------------------------------------------- fts

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** One row per recording: title plus every line of prose flattened, so a hit means "in here". */
function indexFts(tx: Tx, recordingId: number, w: OverviewWrite): void {
  const body = [
    w.tldr,
    ...w.sections.flatMap((s) => [s.heading, ...s.bullets.map((b) => b.text)]),
    ...w.decisions.map((d) => d.text),
    ...w.tasks.map((t) => t.text),
  ]
    .filter(Boolean)
    .join("\n");

  tx.run(sql`DELETE FROM overview_fts WHERE recording_id = ${recordingId}`);
  tx.run(
    sql`INSERT INTO overview_fts (title, body, recording_id) VALUES (${w.title}, ${body}, ${recordingId})`,
  );
}

/**
 * Overview matches, shaped like transcript matches so one list can hold both. There is no
 * moment to seek to — the summary is about the whole recording — so the hit opens the tab.
 */
export function searchOverviews(db: Db, query: string, limit: number): SearchHit[] {
  const phrase = `"${query.replaceAll('"', '""')}"`;
  const rows = db.$client
    .prepare(
      `SELECT f.recording_id AS recording_id, r.path AS path, coalesce(r.title, r.ai_title) AS title,
              snippet(overview_fts, 1, '<b>', '</b>', '…', 8) AS snippet
       FROM overview_fts f
       JOIN recordings r ON r.id = f.recording_id
       WHERE overview_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(phrase, limit) as { recording_id: number; path: string; title: string | null; snippet: string }[];

  return rows.map((r) => ({
    kind: "overview" as const,
    recording_id: r.recording_id,
    filename: basename(r.path) || r.path,
    title: r.title,
    segment_id: 0,
    start_ms: 0,
    snippet: r.snippet,
  }));
}

// ------------------------------------------------------------------------------- helpers

/** Punctuation and case only — enough to catch "Ship the docs." vs "ship the docs". */
const normalize = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
