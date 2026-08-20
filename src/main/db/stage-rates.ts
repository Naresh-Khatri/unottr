// What each stage costs on this machine, in wall ms per ms of source audio. Written when a
// stage finishes, read by the eta before the next one starts (see ingest/eta.ts for why the
// number is shaped like that).

import { eq } from "drizzle-orm";
import type { Db } from "./client";
import { now } from "./recordings";
import { stageRates } from "./schema";

/**
 * Weight of a new measurement. Low enough that one thermally-throttled or contended run does
 * not move the number much, high enough that swapping the gpu in is picked up within a few
 * recordings rather than a few dozen.
 */
const ALPHA = 0.3;

/** Below this, model load and process spawn dominate and the ratio says nothing about speed. */
const MIN_AUDIO_MS = 30_000;

/** Outside this a "rate" is an artifact — a resumed stage, a suspended laptop — not a speed. */
const MIN_RATE = 1e-5;
const MAX_RATE = 100;

export function rate(db: Db, key: string, fallback: number): number {
  return db.select().from(stageRates).where(eq(stageRates.key, key)).get()?.rate ?? fallback;
}

/** Fold one finished stage into its rate. Silently ignores anything not worth learning from. */
export function record(db: Db, key: string, wallMs: number, audioMs: number): void {
  if (audioMs < MIN_AUDIO_MS || wallMs <= 0) return;
  const observed = wallMs / audioMs;
  if (observed < MIN_RATE || observed > MAX_RATE) return;

  const prev = db.select().from(stageRates).where(eq(stageRates.key, key)).get();
  const next = prev ? prev.rate * (1 - ALPHA) + observed * ALPHA : observed;
  db.insert(stageRates)
    .values({ key, rate: next, samples: 1, updatedAt: now() })
    .onConflictDoUpdate({
      target: stageRates.key,
      set: { rate: next, samples: (prev?.samples ?? 0) + 1, updatedAt: now() },
    })
    .run();
}
