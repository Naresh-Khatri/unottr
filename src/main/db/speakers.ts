// Hand fixes to what diarization decided (decision #50). None of these touches transcript
// text — only which speaker a row points at — so fts stays valid and nothing regenerates on
// its own; each one bumps `recordings.speakers_version`, which is what makes an overview
// written against the old cast knowably stale.

import { eq, sql } from "drizzle-orm";
import type { Db } from "./client";
import { now } from "./recordings";
import { recordings, segments, speakers, tasks } from "./schema";

/** Drizzle's transaction handle — same query surface as {@link Db}, different class. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Conn = Db | Tx;

export function bumpVersion(db: Conn, recordingId: number): void {
  db.update(recordings)
    .set({ speakersVersion: sql`${recordings.speakersVersion} + 1`, updatedAt: now() })
    .where(eq(recordings.id, recordingId))
    .run();
}

const speakerRow = (db: Conn, id: number) =>
  db
    .select({ recordingId: speakers.recordingId, personId: speakers.personId })
    .from(speakers)
    .where(eq(speakers.id, id))
    .get();

/** How many segments a merge would move — the number the inline confirm quotes. */
export function segmentCount(db: Db, speakerId: number): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(segments)
      .where(eq(segments.speakerId, speakerId))
      .get()?.n ?? 0
  );
}

/**
 * Fold `from` into `into`: one voice the clusterer split in two. The voiceprint is left
 * alone on purpose — enrolment happens on naming (decision #4), and a merge is not a naming.
 */
export function mergeSpeakers(db: Db, fromId: number, intoId: number): void {
  if (fromId === intoId) throw new Error("a speaker cannot be merged into itself");
  db.transaction((tx) => {
    const from = speakerRow(tx, fromId);
    const into = speakerRow(tx, intoId);
    if (!from) throw new Error(`no speaker with id ${fromId}`);
    if (!into) throw new Error(`no speaker with id ${intoId}`);
    if (from.recordingId !== into.recordingId) throw new Error("those speakers are in different recordings");

    tx.update(segments).set({ speakerId: intoId }).where(eq(segments.speakerId, fromId)).run();
    tx.update(tasks).set({ ownerSpeakerId: intoId }).where(eq(tasks.ownerSpeakerId, fromId)).run();

    // an identity outranks a local rename, and the two are never both set (people.nameSpeaker)
    if (from.personId !== null && into.personId === null) {
      tx.update(speakers)
        .set({ personId: from.personId, displayName: null })
        .where(eq(speakers.id, intoId))
        .run();
    }

    tx.delete(speakers).where(eq(speakers.id, fromId)).run();
    bumpVersion(tx, from.recordingId);
  });
}

/** Move one segment onto another of this recording's speakers, or off all of them (null). */
export function setSegmentSpeaker(db: Db, segmentId: number, speakerId: number | null): void {
  db.transaction((tx) => {
    const seg = tx
      .select({ recordingId: segments.recordingId })
      .from(segments)
      .where(eq(segments.id, segmentId))
      .get();
    if (!seg) throw new Error(`no segment with id ${segmentId}`);

    if (speakerId !== null) {
      const target = speakerRow(tx, speakerId);
      if (!target) throw new Error(`no speaker with id ${speakerId}`);
      if (target.recordingId !== seg.recordingId) throw new Error("that speaker is in another recording");
    }

    // tasks are owned by whoever the model said, not by the segment they cite — left alone
    tx.update(segments).set({ speakerId }).where(eq(segments.id, segmentId)).run();
    bumpVersion(tx, seg.recordingId);
  });
}

/** "New speaker" on a segment: a fresh cluster with the next free label, in one go. */
export function assignToNewSpeaker(db: Db, segmentId: number): number {
  return db.transaction((tx) => {
    const seg = tx
      .select({ recordingId: segments.recordingId })
      .from(segments)
      .where(eq(segments.id, segmentId))
      .get();
    if (!seg) throw new Error(`no segment with id ${segmentId}`);

    const id = tx
      .insert(speakers)
      .values({ recordingId: seg.recordingId, label: nextLabel(tx, seg.recordingId) })
      .returning({ id: speakers.id })
      .get().id;
    tx.update(segments).set({ speakerId: id }).where(eq(segments.id, segmentId)).run();
    bumpVersion(tx, seg.recordingId);
    return id;
  });
}

/** One past the highest "Speaker N" still in use, so a merge frees its label for reuse. */
function nextLabel(tx: Tx, recordingId: number): string {
  const used = tx
    .select({ label: speakers.label })
    .from(speakers)
    .where(eq(speakers.recordingId, recordingId))
    .all();
  const highest = used.reduce((max, r) => Math.max(max, Number(/^Speaker (\d+)$/.exec(r.label)?.[1] ?? 0)), 0);
  return `Speaker ${highest + 1}`;
}
