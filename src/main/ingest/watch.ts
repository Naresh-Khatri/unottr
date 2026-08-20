// Port of crates/unottr-core/src/ingest/watch.rs: folder watching, completion detection, and
// the missing-file/fingerprint sweep.
//
// Rust staged completion as inotify CLOSE_WRITE -> size-stable -> ffprobe. chokidar exposes no
// CLOSE_WRITE, so `awaitWriteFinish` collapses the first two for files it sees, and files found
// by the periodic rescan still serve the size-stability ticks. The ffprobe gate is the real
// safety net either way and is never skipped: an in-progress mp4 has no readable duration, so
// it cannot pass.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type FSWatcher, watch as chokidar } from "chokidar";
import type { Db } from "../db/client";
import {
  availablePaths,
  findByFingerprint,
  findByPath,
  fingerprintOf,
  insertDiscovered,
  markUnavailable,
  relink,
  restoreIfUnavailable,
} from "../db/recordings";
import { listEnabled } from "../db/watch-folders";
import type { FfmpegCli } from "../media/ffmpeg";
import { probe } from "../media/ffmpeg";
import { type IngestConfig, awaitWriteFinish, hasExtension } from "./config";
import { compute } from "./fingerprint";

/** A file seen in a watched folder but not yet promoted to a `recordings` row: still being
 *  written, or waiting out the bounded ffprobe retries. */
export interface Candidate {
  lastSize: number;
  stableTicks: number;
  probeChecks: number;
  /** chokidar's awaitWriteFinish already held it still; skip straight to the probe. */
  settled: boolean;
}

export type Candidates = Map<string, Candidate>;

const fresh = (settled: boolean, lastSize = 0): Candidate => ({
  lastSize,
  stableTicks: 0,
  probeChecks: 0,
  settled,
});

export interface WatcherOptions {
  db: Db;
  cli: FfmpegCli;
  cfg: IngestConfig;
  /** A brand new `discovered` row: emit the event and queue the job. */
  onDiscovered: (id: number) => void;
}

export class Watcher {
  private readonly candidates: Candidates = new Map();
  private readonly watched = new Set<string>();
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private tick: Promise<void> = Promise.resolve();
  private stopped = false;
  private lastRescan = 0; // 0 -> the first tick is a full rescan

  constructor(private readonly o: WatcherOptions) {}

  start(): void {
    this.watcher = chokidar([], {
      depth: 0,
      ignoreInitial: false,
      awaitWriteFinish: awaitWriteFinish(this.o.cfg),
      alwaysStat: true,
    });
    this.watcher.on("add", (path, stats) => this.sighted(path, stats?.size ?? 0));
    this.watcher.on("change", (path, stats) => this.sighted(path, stats?.size ?? 0));
    this.watcher.on("unlink", (path) => this.candidates.delete(path));
    this.watcher.on("error", () => {}); // a folder yanked mid-watch; the rescan recovers
    this.schedule(0);
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.tick;
    await this.watcher?.close();
    this.watcher = null;
  }

  private sighted(path: string, size: number): void {
    if (!hasExtension(this.o.cfg, path)) return;
    const id = findByPath(this.o.db, path);
    if (id !== null) {
      restoreIfUnavailable(this.o.db, id); // came back at the path it was last known at
      return;
    }
    if (!this.candidates.has(path)) this.candidates.set(path, fresh(true, size));
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.tick = this.runTick()
        .catch(() => {}) // a db or fs fault this tick; the next one retries everything
        .finally(() => this.schedule(this.o.cfg.stablePollIntervalMs));
    }, delay);
  }

  private async runTick(): Promise<void> {
    const { db, cli, cfg } = this.o;
    const folders = listEnabled(db).map((f) => f.path);
    this.syncWatches(folders);

    // chokidar drives prompt discovery; the rescan is the backstop for whatever it missed
    const fullRescan = Date.now() - this.lastRescan >= cfg.rescanIntervalMs;
    if (fullRescan) {
      this.lastRescan = Date.now();
      for (const folder of folders) relist(db, folder, cfg, this.candidates);
    }

    await stepCandidates(db, cli, cfg, this.candidates, this.o.onDiscovered);

    if (fullRescan) await sweepMissing(db, folders);
  }

  /** Idempotent. A folder that does not exist yet is dropped so it gets re-added if it comes
   *  back — chokidar will not start watching a path that was missing when it was handed over. */
  private syncWatches(folders: string[]): void {
    const live = new Set(folders);
    for (const path of [...this.watched]) {
      if (!live.has(path) || !isDir(path)) {
        this.watcher?.unwatch(path);
        this.watched.delete(path);
      }
    }
    for (const path of folders) {
      if (!this.watched.has(path) && isDir(path)) {
        this.watcher?.add(path);
        this.watched.add(path);
      }
    }
  }
}

/** One folder's current listing against the db and the in-flight candidate set. Non-recursive. */
export function relist(db: Db, folder: string, cfg: IngestConfig, candidates: Candidates): void {
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return; // folder deleted out from under us — the next rescan notices it reappear
  }
  for (const name of names) {
    const path = join(folder, name);
    if (!hasExtension(cfg, path) || !isFile(path)) continue;
    const id = findByPath(db, path);
    if (id !== null) {
      // reappeared at the exact path it was last known at (not a move)
      restoreIfUnavailable(db, id);
    } else if (!candidates.has(path)) {
      candidates.set(path, fresh(false));
    }
  }
}

export async function stepCandidates(
  db: Db,
  cli: FfmpegCli,
  cfg: IngestConfig,
  candidates: Candidates,
  onDiscovered: (id: number) => void,
): Promise<void> {
  const ready: string[] = [];
  for (const [path, cand] of [...candidates]) {
    const size = sizeOf(path);
    if (size === null) {
      candidates.delete(path); // vanished before it finished writing
      continue;
    }
    if (size !== cand.lastSize) {
      cand.lastSize = size;
      cand.stableTicks = 0;
      cand.probeChecks = 0;
      cand.settled = false; // writing resumed; the write-finish verdict is stale
      continue;
    }
    cand.stableTicks += 1;
    if (!cand.settled && cand.stableTicks < cfg.stableRequiredCount) continue;

    try {
      await probe(cli, path);
      candidates.delete(path);
      ready.push(path);
    } catch {
      cand.probeChecks += 1;
      if (cand.probeChecks >= cfg.maxProbeChecks) {
        // stop waiting — let it reach `probing` for real so it fails visibly instead of
        // sitting in watcher limbo forever
        candidates.delete(path);
        ready.push(path);
      }
    }
  }
  for (const path of ready) await promote(db, path, onDiscovered);
}

/** Size-stable and (probably) probeable: fingerprint it and either re-link an existing row
 *  (moved/renamed file) or insert a fresh `discovered` row and hand it to the queue. */
export async function promote(
  db: Db,
  path: string,
  onDiscovered: (id: number) => void,
): Promise<void> {
  let fp: Awaited<ReturnType<typeof compute>>;
  try {
    fp = await compute(path);
  } catch {
    return; // vanished right at the finish line; the next relist re-tracks it
  }
  const existing = findByFingerprint(db, fp.size, fp.head, fp.tail);
  if (existing !== null) {
    relink(db, existing, path); // moved or renamed: never reprocessed
    return;
  }
  const id = insertDiscovered(db, path, fp.size, fp.head, fp.tail);
  onDiscovered(id);
}

/**
 * Rows whose file vanished from its last known path. Before giving up, search every enabled
 * watch folder's current contents for a fingerprint match (a move that has not made it through
 * the stability window as a fresh candidate yet).
 */
export async function sweepMissing(db: Db, folders: string[]): Promise<void> {
  const missing = availablePaths(db).filter(({ path }) => sizeOf(path) === null);
  for (const { id, path: oldPath } of missing) {
    const fp = fingerprintOf(db, id);
    if (!fp) continue;
    const found = await findByContent(folders, fp.size, fp.head, fp.tail);
    if (found !== null && found !== oldPath) relink(db, id, found);
    else markUnavailable(db, id);
  }
}

async function findByContent(
  folders: string[],
  size: number,
  head: Buffer,
  tail: Buffer,
): Promise<string | null> {
  for (const folder of folders) {
    let names: string[];
    try {
      names = readdirSync(folder);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(folder, name);
      if (sizeOf(path) !== size || !isFile(path)) continue;
      try {
        const fp = await compute(path);
        if (fp.head.equals(head) && fp.tail.equals(tail)) return path;
      } catch {
        // raced with another mover; keep looking
      }
    }
  }
  return null;
}

function sizeOf(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};
