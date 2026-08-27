// Row-level helpers over `recordings`. Port of crates/unottr-core/src/db/recordings.rs —
// the ingest pipeline (08.5) is the main caller; queries.ts uses reset_for_retry.

import { and, eq, notInArray, sql } from "drizzle-orm";
import type { Db } from "./client";
import { type Status, TERMINAL, recordings, segments } from "./schema";

/** Seconds since the epoch. Everything in the schema stores integer unix time. */
export const now = (): number => Math.floor(Date.now() / 1000);

export function findByPath(db: Db, path: string): number | null {
  return db.select({ id: recordings.id }).from(recordings).where(eq(recordings.path, path)).get()?.id ?? null;
}

/**
 * Row id for a path, creating a bare one if it is not tracked yet. Fingerprint columns are
 * zeroed — the watcher is what creates rows with real fingerprints. This exists so a
 * one-off transcribe of an unscanned file has somewhere to write.
 */
export function stub(db: Db, path: string, durationMs?: number | null): number {
  const existing = findByPath(db, path);
  if (existing !== null) return existing;

  const ts = now();
  const row = db
    .insert(recordings)
    .values({
      path,
      fpSize: 0,
      fpHead: Buffer.alloc(0),
      fpTail: Buffer.alloc(0),
      durationMs: durationMs ?? null,
      status: "discovered",
      createdAt: ts,
      updatedAt: ts,
    })
    .returning({ id: recordings.id })
    .get();
  return row.id;
}

/** A brand-new file the watcher has never seen. */
export function insertDiscovered(db: Db, path: string, size: number, head: Buffer, tail: Buffer): number {
  const ts = now();
  return db
    .insert(recordings)
    .values({
      path,
      fpSize: size,
      fpHead: head,
      fpTail: tail,
      status: "discovered",
      available: 1,
      createdAt: ts,
      updatedAt: ts,
    })
    .returning({ id: recordings.id })
    .get().id;
}

export function findByFingerprint(db: Db, size: number, head: Buffer, tail: Buffer): number | null {
  return (
    db
      .select({ id: recordings.id })
      .from(recordings)
      .where(and(eq(recordings.fpSize, size), eq(recordings.fpHead, head), eq(recordings.fpTail, tail)))
      .get()?.id ?? null
  );
}

export interface FingerprintRow {
  size: number;
  head: Buffer;
  tail: Buffer;
}

export function fingerprintOf(db: Db, id: number): FingerprintRow | null {
  const row = db
    .select({ size: recordings.fpSize, head: recordings.fpHead, tail: recordings.fpTail })
    .from(recordings)
    .where(eq(recordings.id, id))
    .get();
  return row ?? null;
}

export function setFingerprint(db: Db, id: number, fp: FingerprintRow): void {
  db.update(recordings)
    .set({ fpSize: fp.size, fpHead: fp.head, fpTail: fp.tail, updatedAt: now() })
    .where(eq(recordings.id, id))
    .run();
}

/** A known path changed after discovery. Terminal rows restart against the new bytes. */
export function refreshChangedSource(db: Db, id: number, fp: FingerprintRow): boolean {
  return db.transaction((tx) => {
    const status = tx
      .select({ status: recordings.status })
      .from(recordings)
      .where(eq(recordings.id, id))
      .get()?.status;
    if (!status || !TERMINAL.includes(status)) return false;

    tx.delete(segments).where(eq(segments.recordingId, id)).run();
    tx.update(recordings)
      .set({
        fpSize: fp.size,
        fpHead: fp.head,
        fpTail: fp.tail,
        durationMs: null,
        status: "discovered",
        error: null,
        attempts: 0,
        lastChunkIdx: null,
        stageDetail: null,
        updatedAt: now(),
      })
      .where(eq(recordings.id, id))
      .run();
    return true;
  });
}

/** Drop checkpoints made from an earlier snapshot before retrying a growing source. */
export function resetForSourceChange(db: Db, id: number): void {
  db.transaction((tx) => {
    tx.delete(segments).where(eq(segments.recordingId, id)).run();
    tx.update(recordings)
      .set({
        status: "discovered",
        error: null,
        attempts: 0,
        lastChunkIdx: null,
        stageDetail: null,
        updatedAt: now(),
      })
      .where(eq(recordings.id, id))
      .run();
  });
}

/** A fingerprint match at a new path: the file moved. Never touches status or attempts. */
export function relink(db: Db, id: number, path: string): void {
  db.update(recordings).set({ path, available: 1, updatedAt: now() }).where(eq(recordings.id, id)).run();
}

/** The file came back at the path it was last seen at — a no-op unless it was marked gone. */
export function restoreIfUnavailable(db: Db, id: number): void {
  db.update(recordings)
    .set({ available: 1, updatedAt: now() })
    .where(and(eq(recordings.id, id), eq(recordings.available, 0)))
    .run();
}

export function markUnavailable(db: Db, id: number): void {
  db.update(recordings).set({ available: 0, updatedAt: now() }).where(eq(recordings.id, id)).run();
}

export function setProbeResult(db: Db, id: number, container: string, durationMs: number | null): void {
  db.update(recordings)
    .set({ container, durationMs, updatedAt: now() })
    .where(eq(recordings.id, id))
    .run();
}

export function setStatus(db: Db, id: number, status: Status, stageDetail: string | null = null): void {
  db.update(recordings).set({ status, stageDetail, updatedAt: now() }).where(eq(recordings.id, id)).run();
}

export function statusOf(db: Db, id: number): Status | null {
  return db.select({ status: recordings.status }).from(recordings).where(eq(recordings.id, id)).get()?.status ?? null;
}

export function pathOf(db: Db, id: number): string | null {
  return db.select({ path: recordings.path }).from(recordings).where(eq(recordings.id, id)).get()?.path ?? null;
}

export function lastChunkIdx(db: Db, id: number): number | null {
  return (
    db.select({ idx: recordings.lastChunkIdx }).from(recordings).where(eq(recordings.id, id)).get()?.idx ?? null
  );
}

export function setForceCpu(db: Db, id: number, forceCpu: boolean): void {
  db.update(recordings)
    .set({ forceCpu: forceCpu ? 1 : 0, updatedAt: now() })
    .where(eq(recordings.id, id))
    .run();
}

export function forceCpuOf(db: Db, id: number): boolean {
  return (
    (db.select({ f: recordings.forceCpu }).from(recordings).where(eq(recordings.id, id)).get()?.f ?? 0) !== 0
  );
}

export type WhisperFallback = "small-metal";

/** model switch invalidates checkpoints; never mix Turbo and Small rows */
export function setWhisperFallback(db: Db, id: number, fallback: WhisperFallback): void {
  db.transaction((tx) => {
    tx.delete(segments).where(eq(segments.recordingId, id)).run();
    tx.update(recordings)
      .set({ whisperFallback: fallback, lastChunkIdx: null, stageDetail: null, updatedAt: now() })
      .where(eq(recordings.id, id))
      .run();
  });
}

export function whisperFallbackOf(db: Db, id: number): WhisperFallback | null {
  return (
    db
      .select({ fallback: recordings.whisperFallback })
      .from(recordings)
      .where(eq(recordings.id, id))
      .get()?.fallback ?? null
  );
}

/**
 * Bumps `attempts`, records the error slug, and parks the row if the policy says so.
 * Returns true if it will be retried. A graceful shutdown never reaches here — the worker
 * treats a cancel as "leave it exactly as it is".
 */
export function failOrRetry(db: Db, id: number, slug: string, park: (attempts: number) => boolean): boolean {
  const ts = now();
  const row = db
    .update(recordings)
    .set({ attempts: sql`${recordings.attempts} + 1`, error: slug, updatedAt: ts })
    .where(eq(recordings.id, id))
    .returning({ attempts: recordings.attempts })
    .get();

  if (!park(row?.attempts ?? 1)) return true;

  db.update(recordings)
    .set({ status: "failed", stageDetail: null, updatedAt: ts })
    .where(eq(recordings.id, id))
    .run();
  return false;
}

/**
 * Retry from the ui, on either terminal state. A failed row keeps `last_chunk_idx` so
 * transcribe resumes instead of redoing finished chunks; a done row is an explicit
 * "transcribe this again", so the checkpoint goes and rewind() drops the old segments.
 * False = the row is in flight (or gone) — a stale or duplicate click; don't enqueue.
 */
export function resetForRetry(db: Db, id: number): boolean {
  const status = statusOf(db, id);
  if (status === null || !TERMINAL.includes(status)) return false;

  const changed = db
    .update(recordings)
    .set({
      status: "discovered",
      error: null,
      attempts: 0,
      stageDetail: null,
      ...(status === "done" ? { lastChunkIdx: null } : {}),
      updatedAt: now(),
    })
    .where(and(eq(recordings.id, id), eq(recordings.status, status)))
    .run();
  return changed.changes > 0;
}

/** Ids in any non-terminal state — what startup reconciliation requeues. */
export function nonTerminal(db: Db): number[] {
  return db
    .select({ id: recordings.id })
    .from(recordings)
    .where(notInArray(recordings.status, TERMINAL))
    .all()
    .map((r) => r.id);
}

/** Every path currently marked available, for the startup "did it disappear" sweep. */
export function availablePaths(db: Db): { id: number; path: string }[] {
  return db
    .select({ id: recordings.id, path: recordings.path })
    .from(recordings)
    .where(eq(recordings.available, 1))
    .all();
}
