// One generation, start to finish. Runs in main, not the worker: the worker exists because
// native addons segfault, and an https call has no such failure mode.

import { APICallError, NoObjectGeneratedError, Output, generateText } from "ai";
import { asc, eq } from "drizzle-orm";
import type { ErrorKind } from "../../shared/ipc";
import type { Db } from "../db/client";
import * as overviewsDb from "../db/overviews";
import { cast, myRole } from "../db/people";
import { recordings, segments } from "../db/schema";
import { events } from "../events";
import { ground } from "./ground";
import * as prompt from "./prompt";
import * as provider from "./provider";
import { overviewSchema } from "./schema";

/** A whole meeting in one call, so the ceiling is generous — but it is not "forever". */
const TIMEOUT_MS = 120_000;

/** Double-click protection that also spans windows: the row is the lock, this is the guard. */
const inFlight = new Set<number>();

export class ConsentError extends Error {
  constructor() {
    super("the AI overview has not been consented to yet");
  }
}

export async function generate(db: Db, recordingId: number, signal?: AbortSignal): Promise<void> {
  if (inFlight.has(recordingId)) return;

  const ai = provider.aiSettings(db);
  if (!ai.key_set) throw new provider.MissingKeyError();
  if (!ai.consented) throw new ConsentError();

  const recording = db
    .select({ recordedAt: recordings.recordedAt, status: recordings.status })
    .from(recordings)
    .where(eq(recordings.id, recordingId))
    .get();
  if (!recording) throw new Error(`no recording with id ${recordingId}`);
  if (recording.status !== "done") throw new Error("the transcript is not finished yet");

  const rows = db
    .select({ id: segments.id, text: segments.text, startMs: segments.startMs, speakerId: segments.speakerId })
    .from(segments)
    .where(eq(segments.recordingId, recordingId))
    .orderBy(asc(segments.startMs), asc(segments.id))
    .all();
  if (!rows.length) throw new Error("there is nothing transcribed to summarize");

  const role = myRole(db);
  const built = prompt.build({
    cast: cast(db, recordingId),
    segments: rows.map((r) => ({ id: r.id, text: r.text, speakerId: r.speakerId })),
    role,
    recordedAt: recording.recordedAt,
    pseudonymize: ai.pseudonymize,
  });

  inFlight.add(recordingId);
  overviewsDb.markRunning(db, recordingId, ai.model, role);
  events.overviewChanged({ recording_id: recordingId });

  try {
    const { output, usage } = await call(db, built, signal);

    const grounded = ground(output, {
      starts: new Map(rows.map((r) => [r.id, r.startMs])),
      speakerIds: built.speakerIds,
    });
    if (grounded.dropped) {
      console.warn(`overview ${recordingId}: dropped ${grounded.dropped} claim(s) citing unknown segments`);
    }

    const tokensIn = usage.inputTokens ?? null;
    const tokensOut = usage.outputTokens ?? null;
    overviewsDb.save(db, recordingId, { ...grounded, model: ai.model, roleUsed: role, tokensIn, tokensOut });
    provider.addSpend(db, ai.model, tokensIn ?? 0, tokensOut ?? 0);
  } catch (err) {
    overviewsDb.markFailed(db, recordingId, message(err), classify(err));
  } finally {
    inFlight.delete(recordingId);
    events.overviewChanged({ recording_id: recordingId });
  }
}

/**
 * One retry, and only for a malformed answer — the model is told what it got wrong. Anything
 * else (auth, rate limit, a dropped socket) is the sdk's own `maxRetries` business, and
 * retrying a 401 in a loop just burns time.
 */
async function call(db: Db, built: prompt.BuiltPrompt, signal?: AbortSignal) {
  const model = provider.model(db);
  const run = (extra: string) =>
    generateText({
      model,
      output: Output.object({ schema: overviewSchema }),
      system: built.system,
      prompt: extra ? `${built.prompt}\n\n${extra}` : built.prompt,
      abortSignal: merge(signal),
    });

  try {
    return await run("");
  } catch (err) {
    if (!isShapeError(err)) throw err;
    return await run(
      `Your previous answer did not match the required schema (${message(err)}). Answer again, same content, valid shape.`,
    );
  }
}

/** The caller's cancel and the hard ceiling are both aborts; the call only knows about one. */
function merge(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

const isShapeError = (err: unknown): boolean =>
  NoObjectGeneratedError.isInstance(err) || (err instanceof Error && err.name === "AI_TypeValidationError");

function classify(err: unknown): ErrorKind {
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) return "aborted";
  if (isShapeError(err)) return "validation";
  if (APICallError.isInstance(err)) {
    if (err.statusCode === 401 || err.statusCode === 403) return "auth";
    if (err.statusCode === 429) return "rate_limit";
    if (err.isRetryable) return "network";
    return "unknown";
  }
  if (err instanceof provider.MissingKeyError) return "auth";
  return "unknown";
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
