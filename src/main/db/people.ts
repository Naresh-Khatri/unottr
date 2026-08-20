// Global speaker identity. A `speakers` row is one recording's cluster; a `people` row is the
// person behind it, and its embedding is the voiceprint the next recording gets matched
// against. Naming a speaker is the only thing that enrolls — an auto-match never feeds itself
// back, so one bad match cannot poison a voiceprint.

import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { Person } from "../../shared/ipc";
import { isEmbedded, normalize } from "../../worker/cluster";
import type { Db } from "./client";
import { fromBlob, toBlob } from "./embedding";
import { now } from "./recordings";
import { people, speakers } from "./schema";

/** Drizzle's transaction handle — same query surface as {@link Db}, different class. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Conn = Db | Tx;

/**
 * Cosine distance at which a cluster is the person we think it is. Tighter than the
 * within-recording cut (cluster.ts `DEFAULT_THRESHOLD` = 0.6): that one compares fragments
 * recorded minutes apart through one mic, this one compares across sessions, rooms and
 * months, where a false match silently puts words in someone's mouth.
 */
export const IDENTIFY_THRESHOLD = 0.45;

/**
 * Two people this close to a cluster are not tellable apart, so it stays anonymous rather
 * than picking the marginally nearer one.
 */
export const IDENTIFY_MARGIN = 0.05;

export interface Voiceprint {
  id: number;
  embedding: Float32Array;
}

const distance = (a: Float32Array, b: Float32Array): number => {
  let dot = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) dot += a[i] * b[i];
  return 1 - dot; // both unit length -> cosine distance
};

/**
 * Match a recording's speaker centroids against known voiceprints. Returns a person id per
 * centroid, or null where nothing matched.
 *
 * Greedy over every pair by distance, because one person cannot be two speakers in the same
 * recording: once a person is spoken for, the runner-up cluster has to find someone else or
 * stay anonymous. `null` centroids are clusters that never embedded.
 */
export function identify(
  centroids: (Float32Array | null)[],
  known: Voiceprint[],
  threshold = IDENTIFY_THRESHOLD,
): (number | null)[] {
  const out: (number | null)[] = centroids.map(() => null);
  if (known.length === 0) return out;

  const pairs: { speaker: number; person: number; d: number }[] = [];
  centroids.forEach((centroid, speaker) => {
    if (!centroid) return;
    const ranked = known
      .map((k) => ({ person: k.id, d: distance(centroid, k.embedding) }))
      .sort((a, b) => a.d - b.d);
    const best = ranked[0];
    if (best.d >= threshold) return;
    // a tie between two voiceprints is a coin flip, and a coin flip is worse than no name
    if (ranked.length > 1 && ranked[1].d - best.d < IDENTIFY_MARGIN) return;
    pairs.push({ speaker, person: best.person, d: best.d });
  });

  pairs.sort((a, b) => a.d - b.d);
  const takenPerson = new Set<number>();
  for (const p of pairs) {
    if (out[p.speaker] !== null || takenPerson.has(p.person)) continue;
    out[p.speaker] = p.person;
    takenPerson.add(p.person);
  }
  return out;
}

/**
 * Fold one more confirmed centroid into a voiceprint. A running mean, so the tenth recording
 * of someone counts for as much as the first and no single noisy cluster drags it.
 */
export function fold(current: Float32Array | null, samples: number, next: Float32Array): Float32Array {
  if (!current || samples <= 0) return normalize(Float32Array.from(next));
  const out = new Float32Array(Math.max(current.length, next.length));
  for (let i = 0; i < out.length; i++) {
    out[i] = ((current[i] ?? 0) * samples + (next[i] ?? 0)) / (samples + 1);
  }
  return normalize(out);
}

/** Case- and space-folded, so "priya " and "Priya" resolve to one person. */
export const nameKey = (name: string): string => name.trim().replace(/\s+/g, " ").toLowerCase();

// --------------------------------------------------------------------------------- reads

/** Every voiceprint worth matching against. People named before they ever had one are skipped. */
export function voiceprints(db: Conn): Voiceprint[] {
  return db
    .select({ id: people.id, embedding: people.embedding })
    .from(people)
    .where(isNotNull(people.embedding))
    .all()
    .flatMap((r) => (r.embedding ? [{ id: r.id, embedding: fromBlob(r.embedding) }] : []));
}

const recordingCount = sql<number>`(
  select count(distinct speakers.recording_id) from speakers where speakers.person_id = people.id
)`;

export function list(db: Conn): Person[] {
  return db
    .select({
      id: people.id,
      name: people.name,
      samples: people.samples,
      recordings: recordingCount,
      created_at: people.createdAt,
    })
    .from(people)
    .orderBy(desc(recordingCount), people.name)
    .all();
}

// -------------------------------------------------------------------------------- writes

/** Get or create by folded name. Casing follows whatever the user typed most recently. */
export function upsertByName(db: Conn, rawName: string): number {
  const name = rawName.trim().replace(/\s+/g, " ");
  const key = nameKey(name);
  if (!key) throw new Error("a person needs a name");

  const found = db.select({ id: people.id }).from(people).where(eq(people.nameKey, key)).get();
  if (found) {
    db.update(people).set({ name, updatedAt: now() }).where(eq(people.id, found.id)).run();
    return found.id;
  }
  const ts = now();
  return db
    .insert(people)
    .values({ name, nameKey: key, samples: 0, createdAt: ts, updatedAt: ts })
    .returning({ id: people.id })
    .get().id;
}

/**
 * Name a speaker, which is the one thing that makes an identity global: the cluster's
 * centroid becomes part of that person's voiceprint and every later recording can find them
 * by voice. A speaker that never embedded still gets the name, just locally (`display_name`).
 */
export function nameSpeaker(db: Db, speakerId: number, rawName: string): void {
  db.transaction((tx) => {
    const speaker = tx
      .select({ id: speakers.id, embedding: speakers.embedding })
      .from(speakers)
      .where(eq(speakers.id, speakerId))
      .get();
    if (!speaker) throw new Error(`no speaker with id ${speakerId}`);

    const name = rawName.trim();
    if (!name) {
      tx.update(speakers).set({ displayName: null, personId: null }).where(eq(speakers.id, speakerId)).run();
      return;
    }

    const centroid = speaker.embedding ? fromBlob(speaker.embedding) : null;
    if (!centroid || !isEmbedded(centroid)) {
      tx.update(speakers).set({ displayName: name, personId: null }).where(eq(speakers.id, speakerId)).run();
      return;
    }

    const personId = upsertByName(tx, name);
    enroll(tx, personId, centroid);
    tx.update(speakers).set({ displayName: null, personId }).where(eq(speakers.id, speakerId)).run();
  });
}

/**
 * Add a centroid to a person's voiceprint. Re-pointing a speaker at someone else does not
 * take its old contribution back out — a running mean has no history to subtract — so a
 * mis-naming is undone by forgetting the person, not by renaming the speaker.
 */
export function enroll(db: Conn, personId: number, centroid: Float32Array): void {
  const row = db
    .select({ embedding: people.embedding, samples: people.samples })
    .from(people)
    .where(eq(people.id, personId))
    .get();
  if (!row) throw new Error(`no person with id ${personId}`);

  const next = fold(row.embedding ? fromBlob(row.embedding) : null, row.samples, centroid);
  db.update(people)
    .set({ embedding: toBlob(next), samples: row.samples + 1, updatedAt: now() })
    .where(eq(people.id, personId))
    .run();
}

/** Rename globally: every recording this person appears in follows, past and future. */
export function rename(db: Db, personId: number, rawName: string): void {
  const name = rawName.trim().replace(/\s+/g, " ");
  const key = nameKey(name);
  if (!key) throw new Error("a person needs a name");

  const clash = db.select({ id: people.id }).from(people).where(eq(people.nameKey, key)).get();
  if (clash && clash.id !== personId) throw new Error(`there is already someone called ${name}`);

  const changed = db
    .update(people)
    .set({ name, nameKey: key, updatedAt: now() })
    .where(eq(people.id, personId))
    .run();
  if (changed.changes === 0) throw new Error(`no person with id ${personId}`);
}

/**
 * Forget a person and their voiceprint. Their speakers go back to anonymous rather than
 * keeping a name nothing stands behind — this is the escape hatch for a bad auto-match.
 */
export function forget(db: Db, personId: number): void {
  db.transaction((tx) => {
    // explicit, not left to the fk: a db adopted from the rust build predates the constraint
    tx.update(speakers).set({ personId: null }).where(eq(speakers.personId, personId)).run();
    const changed = tx.delete(people).where(eq(people.id, personId)).run();
    if (changed.changes === 0) throw new Error(`no person with id ${personId}`);
  });
}

/** Person ids already spoken for in this recording, so identify() cannot hand one out twice. */
export function linkedIn(db: Conn, recordingId: number): number[] {
  return db
    .select({ personId: speakers.personId })
    .from(speakers)
    .where(and(eq(speakers.recordingId, recordingId), isNotNull(speakers.personId)))
    .all()
    .flatMap((r) => (r.personId === null ? [] : [r.personId]));
}
