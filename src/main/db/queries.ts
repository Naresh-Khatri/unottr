// Port of src-tauri/src/ipc/queries.rs — the read side plus the cheap writes, as plain
// functions over a Db so they're testable without a running app.

import { readdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { type SQL, and, asc, desc, eq, like, sql } from "drizzle-orm";
import type {
  DiskUsage,
  Recording,
  RecordingDetail,
  RecordingFilter,
  RecordingSort,
  RecordingSummary,
  SearchHit,
  Segment,
  Settings,
  Speaker,
  Status,
  Word,
} from "../../shared/ipc";
import { check, fromSettings } from "../media/ffmpeg";
import { modelsDir, pcmCacheDir } from "../paths";
import type { Db } from "./client";
import * as peopleDb from "./people";
import { STATUSES, people, recordings, segments, speakerCount, speakers } from "./schema";
import * as settingsDb from "./settings";

// ---------------------------------------------------------------------------- recordings

const SUMMARY_COLUMNS = {
  id: recordings.id,
  path: recordings.path,
  recorded_at: recordings.recordedAt,
  duration_ms: recordings.durationMs,
  status: recordings.status,
  stage_detail: recordings.stageDetail,
  error: recordings.error,
  available: recordings.available,
  speaker_count: speakerCount,
};

type SummaryRow = {
  id: number;
  path: string;
  recorded_at: number | null;
  duration_ms: number | null;
  status: string;
  stage_detail: string | null;
  error: string | null;
  available: number;
  speaker_count: number;
};

function toSummary(r: SummaryRow): RecordingSummary {
  return {
    ...r,
    filename: filename(r.path),
    has_video: hasVideo(r.path),
    status: parseStatusLenient(r.status),
    available: r.available !== 0,
  };
}

const ORDER = {
  recorded_at: recordings.recordedAt,
  duration_ms: recordings.durationMs,
  // no basename() in sqlite; ordering by path matches filename order for a flat tree
  filename: recordings.path,
} as const;

export function listRecordings(db: Db, filter: RecordingFilter, sort: RecordingSort): RecordingSummary[] {
  const where: SQL[] = [];
  if (filter.status) where.push(eq(recordings.status, filter.status));
  if (filter.available !== undefined) where.push(eq(recordings.available, filter.available ? 1 : 0));
  if (filter.query) where.push(like(recordings.path, `%${filter.query}%`));

  const column = ORDER[sort.by] ?? ORDER.recorded_at;
  return db
    .select(SUMMARY_COLUMNS)
    .from(recordings)
    .where(where.length ? and(...where) : undefined)
    .orderBy(sort.dir === "asc" ? asc(column) : desc(column))
    .all()
    .map(toSummary);
}

export function getRecording(db: Db, id: number): RecordingDetail | null {
  const row = db
    .select({ ...SUMMARY_COLUMNS, container: recordings.container })
    .from(recordings)
    .where(eq(recordings.id, id))
    .get();
  if (!row) return null;

  const recording: Recording = { ...toSummary(row), container: row.container };

  const segmentRows = db
    .select()
    .from(segments)
    .where(eq(segments.recordingId, id))
    .orderBy(asc(segments.startMs), asc(segments.id))
    .all();

  // a linked person outranks a local rename; the two are never both set (see people.nameSpeaker)
  const speakerRows = db
    .select({
      id: speakers.id,
      recording_id: speakers.recordingId,
      label: speakers.label,
      display_name: sql<string | null>`coalesce(${people.name}, ${speakers.displayName})`,
      person_id: speakers.personId,
    })
    .from(speakers)
    .leftJoin(people, eq(people.id, speakers.personId))
    .where(eq(speakers.recordingId, id))
    .orderBy(asc(speakers.label))
    .all();

  return {
    recording,
    segments: segmentRows.map(
      (s): Segment => ({
        id: s.id,
        chunk_idx: s.chunkIdx,
        start_ms: s.startMs,
        end_ms: s.endMs,
        text: s.text,
        words: parseWords(s.words),
        speaker_id: s.speakerId,
        split_of: s.splitOf,
      }),
    ),
    speakers: speakerRows as Speaker[],
  };
}

export function recordingPath(db: Db, id: number): string | null {
  return db.select({ path: recordings.path }).from(recordings).where(eq(recordings.id, id)).get()?.path ?? null;
}

// ------------------------------------------------------------------------------- search

interface SearchRow {
  recording_id: number;
  path: string;
  segment_id: number;
  start_ms: number;
  snippet: string;
}

/**
 * Raw sql: `snippet()` and the `rank` ordering have no drizzle equivalent. The whole query
 * goes in as one quoted phrase, which keeps arbitrary user input out of fts5's query syntax.
 */
export function search(db: Db, query: string, limit: number): SearchHit[] {
  const phrase = `"${query.replaceAll('"', '""')}"`;
  const rows = db.$client
    .prepare(
      `SELECT s.recording_id AS recording_id, r.path AS path, s.id AS segment_id, s.start_ms AS start_ms,
              snippet(segments_fts, 0, '<b>', '</b>', '…', 8) AS snippet
       FROM segments_fts
       JOIN segments s ON s.id = segments_fts.rowid
       JOIN recordings r ON r.id = s.recording_id
       WHERE segments_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(phrase, limit) as SearchRow[];

  return rows.map(({ path, ...hit }) => ({ ...hit, filename: filename(path) }));
}

// ----------------------------------------------------------------------------- speakers

/**
 * Naming a speaker names a *person*: the cluster's voiceprint is enrolled so later recordings
 * recognise them. Empty name clears it. Unknown speaker id is an error.
 */
export const renameSpeaker = peopleDb.nameSpeaker;

// ----------------------------------------------------------------------------- settings

export function getSettings(db: Db, trayAvailable: boolean): Settings {
  const s = settingsDb.load(db);
  // cheap enough to run every call (two `-version` spawns): only hit on settings screen
  // loads/saves, never per-recording
  const ffmpeg_ok = check(fromSettings(s.ffmpeg_path, s.ffprobe_path));
  return {
    ...s,
    tray_available: trayAvailable,
    first_run_complete: settingsDb.getRaw(db, settingsDb.keys.FIRST_RUN_COMPLETE) === "1",
    ffmpeg_ok,
  };
}

/** Persists one pair and returns the reloaded settings; the caller validates first. */
export function setSetting(db: Db, key: string, value: string, trayAvailable: boolean): Settings {
  settingsDb.setRaw(db, key, value);
  return getSettings(db, trayAvailable);
}

export function diskUsage(): DiskUsage {
  return { models_bytes: dirSize(modelsDir()), cache_bytes: dirSize(pcmCacheDir()) };
}

/** Non-recursive on purpose — models/pcm are both flat directories, never nested. */
function dirSize(dir: string): number {
  let total = 0;
  try {
    for (const name of readdirSync(dir)) {
      try {
        total += statSync(join(dir, name)).size;
      } catch {
        // raced with a delete; skip it
      }
    }
  } catch {
    return 0;
  }
  return total;
}

// ------------------------------------------------------------------------------ helpers

const filename = (path: string): string => basename(path) || path;

// has_video isn't persisted (no column for it), so it's derived from the extension
const VIDEO_EXTS = ["mp4", "mkv", "mov", "webm", "avi", "m4v", "ts", "flv", "wmv"];

const hasVideo = (path: string): boolean =>
  VIDEO_EXTS.includes(extname(path).slice(1).toLowerCase());

/** Rows written before this status set existed (e.g. "pending") must not fail a whole list. */
function parseStatusLenient(raw: string): Status {
  if ((STATUSES as readonly string[]).includes(raw)) return raw as Status;
  console.warn(`unrecognized recording status ${JSON.stringify(raw)}; treating as discovered`);
  return "discovered";
}

function parseWords(raw: string | null): Word[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
