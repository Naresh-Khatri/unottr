// Port of crates/unottr-core/src/db/watch_folders.rs. `track_rule` stays the raw string on
// the wire ("auto" or a json TrackRule) — parsing belongs to the watcher, not here.

import { eq } from "drizzle-orm";
import type { WatchFolder } from "../../shared/ipc";
import type { Db } from "./client";
import { watchFolders } from "./schema";

const COLUMNS = {
  id: watchFolders.id,
  path: watchFolders.path,
  track_rule: watchFolders.trackRule,
  enabled: watchFolders.enabled,
};

type Row = { id: number; path: string; track_rule: string; enabled: number };
const toWire = (r: Row): WatchFolder => ({ ...r, enabled: r.enabled !== 0 });

/** ORDER BY path — the ui lists folders alphabetically, not by insertion order. */
export function list(db: Db): WatchFolder[] {
  return db.select(COLUMNS).from(watchFolders).orderBy(watchFolders.path).all().map(toWire);
}

export function listEnabled(db: Db): WatchFolder[] {
  return db
    .select(COLUMNS)
    .from(watchFolders)
    .where(eq(watchFolders.enabled, 1))
    .orderBy(watchFolders.id)
    .all()
    .map(toWire);
}

export function get(db: Db, id: number): WatchFolder | null {
  const row = db.select(COLUMNS).from(watchFolders).where(eq(watchFolders.id, id)).get();
  return row ? toWire(row) : null;
}

export function findByPath(db: Db, path: string): WatchFolder | null {
  const row = db.select(COLUMNS).from(watchFolders).where(eq(watchFolders.path, path)).get();
  return row ? toWire(row) : null;
}

/** Idempotent, and deliberately leaves `enabled` alone — backfill registers folders too. */
export function add(db: Db, path: string): WatchFolder {
  const existing = findByPath(db, path);
  if (existing) return existing;
  return toWire(db.insert(watchFolders).values({ path }).returning(COLUMNS).get());
}

/** What the ui's "add folder" button calls: re-adding a folder you disabled turns it back on. */
export function addOrEnable(db: Db, path: string): WatchFolder {
  return toWire(
    db
      .insert(watchFolders)
      .values({ path })
      .onConflictDoUpdate({ target: watchFolders.path, set: { enabled: 1 } })
      .returning(COLUMNS)
      .get(),
  );
}

export function remove(db: Db, id: number): void {
  db.delete(watchFolders).where(eq(watchFolders.id, id)).run();
}

export function setEnabled(db: Db, id: number, enabled: boolean): void {
  db.update(watchFolders)
    .set({ enabled: enabled ? 1 : 0 })
    .where(eq(watchFolders.id, id))
    .run();
}

export function setTrackRule(db: Db, id: number, rule: string): void {
  db.update(watchFolders).set({ trackRule: rule }).where(eq(watchFolders.id, id)).run();
}
