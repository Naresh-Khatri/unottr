// Port of crates/unottr-core/src/export.rs. Pure serialization — the caller writes the file.

import { basename } from "node:path";
import { asc, eq, sql } from "drizzle-orm";
import type { ExportFormat } from "../shared/ipc";
import type { Db } from "./db/client";
import { recordings, segments, speakers } from "./db/schema";

const FORMATS: ExportFormat[] = ["txt", "json", "srt", "vtt"];

export const parseFormat = (s: string): ExportFormat | null =>
  FORMATS.includes(s as ExportFormat) ? (s as ExportFormat) : null;

export interface ExportSegment {
  start_ms: number;
  end_ms: number;
  speaker: string | null;
  text: string;
}

export interface Transcript {
  filename: string;
  segments: ExportSegment[];
}

/**
 * Speaker column is the rename if there is one, else the auto-assigned label, else null for
 * an unattributed segment — never guessed, same as the transcript view.
 */
export function load(db: Db, recordingId: number): Transcript {
  const path = db
    .select({ path: recordings.path })
    .from(recordings)
    .where(eq(recordings.id, recordingId))
    .get()?.path;
  if (path === undefined) throw new Error(`no recording with id ${recordingId}`);

  const rows = db
    .select({
      start_ms: segments.startMs,
      end_ms: segments.endMs,
      text: segments.text,
      speaker: sql<string | null>`coalesce(${speakers.displayName}, ${speakers.label})`,
    })
    .from(segments)
    .leftJoin(speakers, eq(speakers.id, segments.speakerId))
    .where(eq(segments.recordingId, recordingId))
    .orderBy(asc(segments.startMs), asc(segments.id))
    .all();

  return { filename: basename(path) || path, segments: rows };
}

export function render(format: ExportFormat, t: Transcript): string {
  switch (format) {
    case "txt":
      return t.segments.map((s) => `[${hms(s.start_ms)}] ${prefix(s)}${s.text}\n`).join("");
    case "json":
      return JSON.stringify(t, null, 2);
    case "srt":
      return subtitles(t, srtTs, "");
    case "vtt":
      return subtitles(t, vttTs, "WEBVTT\n\n");
  }
}

const prefix = (s: ExportSegment): string => (s.speaker ? `${s.speaker}: ` : "");

function subtitles(t: Transcript, ts: (ms: number) => string, header: string): string {
  return t.segments.reduce(
    (out, s, i) => `${out}${i + 1}\n${ts(s.start_ms)} --> ${ts(s.end_ms)}\n${prefix(s)}${s.text}\n\n`,
    header,
  );
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

function hms(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
}

/** SRT puts a comma between seconds and milliseconds; WebVTT a period. */
const srtTs = (ms: number): string => `${hms(ms)},${pad(Math.max(0, ms) % 1000, 3)}`;
const vttTs = (ms: number): string => `${hms(ms)}.${pad(Math.max(0, ms) % 1000, 3)}`;
