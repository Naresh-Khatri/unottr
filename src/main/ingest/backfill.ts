// Port of crates/unottr-core/src/ingest/backfill.rs. A folder added after files already exist
// in it: report what is there and do nothing else until explicitly confirmed. `confirm` only
// inserts `discovered` rows — a running service enqueues them, otherwise they sit until the
// next reconciliation picks them up as non-terminal.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { BackfillEstimate } from "../../shared/ipc";
import type { Db } from "../db/client";
import { findByFingerprint, findByPath, insertDiscovered, relink } from "../db/recordings";
import { err } from "../errors";
import { type FfmpegCli, probe } from "../media/ffmpeg";
import { type IngestConfig, hasExtension } from "./config";
import { compute } from "./fingerprint";

/** Read-only. Unprobeable files (still writing, corrupt) count toward `count` but contribute
 *  nothing to the duration estimate. */
export async function scan(
  folder: string,
  cfg: IngestConfig,
  cli: FfmpegCli,
): Promise<BackfillEstimate> {
  let count = 0;
  let total = 0;
  for (const path of matching(folder, cfg)) {
    count += 1;
    try {
      total += (await probe(cli, path)).duration_ms ?? 0;
    } catch {
      // counted, but it contributes no duration
    }
  }
  return {
    folder,
    count,
    total_duration_ms: total,
    estimated_processing_ms: Math.trunc(total * cfg.realtimeFactor),
  };
}

/**
 * Inserts `discovered` rows for every matching file not already known (by path or by
 * fingerprint — a moved file re-links instead). Returns the ids of freshly discovered rows;
 * re-linked files are not reprocessed, so they are not included.
 */
export async function confirm(
  db: Db,
  folder: string,
  cfg: IngestConfig,
  onProgress?: (done: number, total: number) => void,
): Promise<number[]> {
  const discovered: number[] = [];
  const paths = matching(folder, cfg);
  onProgress?.(0, paths.length);
  for (const [index, path] of paths.entries()) {
    if (findByPath(db, path) !== null) {
      onProgress?.(index + 1, paths.length);
      continue;
    }
    let fp: Awaited<ReturnType<typeof compute>>;
    try {
      fp = await compute(path);
    } catch {
      onProgress?.(index + 1, paths.length);
      continue; // vanished between scan and confirm
    }
    const existing = findByFingerprint(db, fp.size, fp.head, fp.tail);
    if (existing !== null) relink(db, existing, path);
    else discovered.push(insertDiscovered(db, path, fp.size, fp.head, fp.tail));
    onProgress?.(index + 1, paths.length);
  }
  return discovered;
}

/** Non-recursive, same allowlist the watcher uses. An unreadable folder is the caller's error. */
function matching(folder: string, cfg: IngestConfig): string[] {
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch (e) {
    throw err.io(folder, e);
  }
  return names
    .map((n) => join(folder, n))
    .filter((p) => hasExtension(cfg, p) && isFile(p))
    .sort();
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};
