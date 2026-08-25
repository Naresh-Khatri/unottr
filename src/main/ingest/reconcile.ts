// Port of crates/unottr-core/src/ingest/reconcile.rs. `processRecording` always runs the full
// probe -> extract -> transcribe -> diarize sequence regardless of which stage a row was left
// at (probing is cheap, extraction is cache-by-existence, transcribe auto-resumes via
// `last_chunk_idx`, diarize is safe to rerun) — so "resume" here means "requeue every
// non-terminal row" rather than dispatching per-stage.

import { readdirSync, rmSync } from "node:fs";
import { join, parse } from "node:path";
import type { Db } from "../db/client";
import { nonTerminal, pathOf } from "../db/recordings";

/** Non-terminal rows to hand back to the queue. */
export function run(db: Db): number[] {
  return nonTerminal(db);
}

/**
 * Cache entries belong to whichever recording's file stem they are named after (see
 * `pcmPathFor`). Anything not backing a currently non-terminal recording is either finished
 * (extraction is behind it) or orphaned — either way, safe to drop.
 */
export function clearStalePcmCache(db: Db, cacheDir: string): void {
  const keep = new Set<string>();
  for (const id of nonTerminal(db)) {
    const path = pathOf(db, id);
    if (path) keep.add(parse(path).name);
  }

  let entries: string[];
  try {
    entries = readdirSync(cacheDir);
  } catch {
    return;
  }
  for (const name of entries) {
    const stem = stemOfCacheFile(name);
    if (stem !== null && !keep.has(stem)) {
      try {
        rmSync(join(cacheDir, name));
      } catch {
        // another process holds it, or it went already; the next startup retries
      }
    }
  }
}

/**
 * `{stem}.t{n}.pcm` or `{stem}.mix.pcm` -> `stem`, searching from the right so a stem that
 * itself contains dots (real filenames do) is not truncated early.
 */
export function stemOfCacheFile(name: string): string | null {
  if (name.endsWith(".source.json")) name = name.slice(0, -".source.json".length);
  if (!name.endsWith(".pcm")) return null;
  const base = name.slice(0, -4);
  if (base.endsWith(".mix")) return base.slice(0, -4);
  const at = base.lastIndexOf(".t");
  if (at < 0) return null;
  const digits = base.slice(at + 2);
  return digits.length > 0 && /^\d+$/.test(digits) ? base.slice(0, at) : null;
}
