// One generation, start to finish. Runs in main, not the worker: the worker exists because
// native addons segfault, and an https call has no such failure mode.

import { APICallError } from "ai";
import { asc, eq } from "drizzle-orm";
import type { ErrorKind } from "../../shared/ipc";
import type { Db } from "../db/client";
import * as overviewsDb from "../db/overviews";
import { cast, myRole } from "../db/people";
import { recordings, segments } from "../db/schema";
import { events } from "../events";
import { askBackend } from "./backend";
import { CliProcessError } from "./cli";
import * as connections from "./connections";
import { ground } from "./ground";
import * as prompt from "./prompt";
import { type OverviewOutput, overviewExample, overviewHeadSchema, overviewSchema } from "./schema";
import { merge, windows } from "./split";
import { isShapeError } from "./structured";

/** The floor under any one call: below this, a provider that is merely busy looks broken. */
const MIN_TIMEOUT_MS = 120_000;

/**
 * How much longer a big prompt earns. A flat ceiling cannot tell a slow server from a hung
 * one, and gets it wrong in the expensive direction: a local model reading a full window at
 * ~25 tokens a second spends over two minutes before the first token of answer exists, so a
 * two-minute ceiling cancels every run it will ever be asked to do. The prompt's own size is
 * the thing that knows better, and the figure here is a floor on throughput, not a guess at
 * it — anything with a gpu beats it by an order of magnitude and never notices the ceiling.
 */
const PROMPT_TOKENS_PER_SEC = 10;

/** Writing the answer is a token at a time and cannot be batched; it is the slower half. */
const ANSWER_MS = 180_000;

/** Past this a server is not slow, it is gone, and the clock in the ui is just cruelty. */
const MAX_TIMEOUT_MS = 20 * 60_000;

/** Rough, and only ever used to say "this won't fit" before spending anything. */
const CHARS_PER_TOKEN = 4;

/** Headroom the answer needs; a full context of input leaves nowhere to write. */
const OUTPUT_RESERVE_TOKENS = 3_000;

/** A window answers for its own slice — a section or two, not six — so it needs less room.
 *  Only spent once splitting is already certain: the room saved is one less window. */
const PART_RESERVE_TOKENS = 1_200;

/** Double-click protection that also spans windows: the row is the lock, this is the guard. */
const inFlight = new Set<number>();

export class ConsentError extends Error {
  constructor() {
    super("this connection has not been consented to yet");
  }
}

/**
 * Not "too much transcript" — that is split up and sent in windows. This is the case no
 * amount of splitting survives: a context so small the instructions alone will not fit.
 */
export class ContextError extends Error {
  constructor(limit: number, model: string) {
    super(
      `${model} holds only ${limit.toLocaleString()} tokens, which is not enough room for the instructions and an answer — pick a model with a longer context, or raise the context size on this connection`,
    );
  }
}

export async function generate(db: Db, recordingId: number, signal?: AbortSignal): Promise<void> {
  if (inFlight.has(recordingId)) return;

  const primary = connections.active(db);
  if (!primary) throw new connections.MissingConnectionError();
  validateConnection(primary);
  const fallback = primary.kind === "cli" ? connections.fallback(db) : null;

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
  const lines = rows.map((r) => ({ id: r.id, text: r.text, speakerId: r.speakerId }));
  const base: Omit<prompt.PromptInput, "segments" | "part"> = {
    cast: cast(db, recordingId),
    role,
    recordedAt: recording.recordedAt,
    pseudonymize: connections.settings(db).pseudonymize,
  };
  const built = prompt.build({ ...base, segments: lines });

  inFlight.add(recordingId);
  overviewsDb.markRunning(db, recordingId, displayModel(primary), primary.label, role);
  events.overviewChanged({ recording_id: recordingId });

  try {
    let used = primary;
    let answer;
    try {
      answer = await runConnection(db, primary, lines, built, base, recordingId, signal);
    } catch (primaryError) {
      if (!fallback || signal?.aborted) throw primaryError;
      validateConnection(fallback);
      used = fallback;
      overviewsDb.markRunning(db, recordingId, displayModel(fallback), fallback.label, role);
      events.overviewChanged({ recording_id: recordingId });
      answer = await runConnection(db, fallback, lines, built, base, recordingId, signal);
    }

    const { object, usage } = answer;

    const grounded = ground(object, {
      starts: new Map(rows.map((r) => [r.id, r.startMs])),
      speakerIds: built.speakerIds,
    });
    if (grounded.dropped) {
      console.warn(`overview ${recordingId}: dropped ${grounded.dropped} claim(s) citing unknown segments`);
    }

    const tokensIn = usage.inputTokens ?? null;
    const tokensOut = usage.outputTokens ?? null;
    overviewsDb.save(db, recordingId, {
      ...grounded,
      model: answer.model ?? displayModel(used),
      provider: used.label,
      roleUsed: role,
      tokensIn,
      tokensOut,
    });
    connections.addSpend(db, used, tokensIn ?? 0, tokensOut ?? 0);
  } catch (err) {
    overviewsDb.markFailed(db, recordingId, message(err), classify(err));
  } finally {
    inFlight.delete(recordingId);
    events.overviewChanged({ recording_id: recordingId });
  }
}

function validateConnection(conn: connections.Row): void {
  if (connections.needsKey(conn)) throw new connections.MissingKeyError(conn.label);
  if (conn.consented !== 1) throw new ConsentError();
  if (conn.kind === "http" && !conn.activeModel) throw new Error(`${conn.label} has no model selected`);
  if (conn.kind === "cli" && !conn.executablePath) throw new Error(`${conn.label} has no executable selected`);
}

function displayModel(conn: connections.Row): string {
  return conn.activeModel ?? `${conn.label} default`;
}

async function runConnection(
  db: Db,
  conn: connections.Row,
  lines: prompt.PromptSegment[],
  built: prompt.BuiltPrompt,
  base: Omit<prompt.PromptInput, "segments" | "part">,
  recordingId: number,
  signal?: AbortSignal,
) {
  const plan = conn.contextTokens ? planWindows(lines, built, conn.contextTokens) : [];
  if (conn.contextTokens && !plan.length) throw new ContextError(conn.contextTokens, displayModel(conn));
  const attempt = (chunks: prompt.PromptSegment[][]) =>
    chunks.length > 1
      ? inParts(conn, chunks, base, recordingId, signal)
      : call(conn, built, signal);

  return attempt(plan).catch((err: unknown) => {
    const limit = contextLimitFrom(err);
    if (!limit) throw err;
    connections.setContextTokens(db, conn.id, limit);
    const halved = Math.min(
      budgetChars(built, limit, PART_RESERVE_TOKENS),
      Math.ceil(built.transcriptChars / 2),
    );
    const replan = windows(lines, halved);
    if (replan.length < 2) throw new ContextError(limit, displayModel(conn));
    return attempt(replan);
  });
}

/**
 * One retry, and only for a malformed answer — the model is told what it got wrong. Anything
 * else (auth, rate limit, a dropped socket) is the sdk's own `maxRetries` business, and
 * retrying a 401 in a loop just burns time.
 */
async function call(conn: connections.Row, built: prompt.BuiltPrompt, signal?: AbortSignal) {
  const run = (extra: string) =>
    askBackend({
      connection: conn,
      schema: overviewSchema,
      example: overviewExample,
      system: built.system,
      prompt: extra ? `${built.prompt}\n\n${extra}` : built.prompt,
      abortSignal: deadline(conn, built, signal),
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

/**
 * Window by window, then one small call for the two fields no window could answer. Sequential
 * on purpose: a local server has one slot, and firing four 8k requests at it concurrently is
 * a slower way to reach the same answer, when it does not simply queue them anyway.
 */
async function inParts(
  conn: connections.Row,
  plan: prompt.PromptSegment[][],
  base: Omit<prompt.PromptInput, "segments" | "part">,
  recordingId: number,
  signal?: AbortSignal,
) {
  const usage = { inputTokens: 0, outputTokens: 0 };
  let actualModel: string | null = null;
  const add = (u: { inputTokens?: number; outputTokens?: number }) => {
    usage.inputTokens += u.inputTokens ?? 0;
    usage.outputTokens += u.outputTokens ?? 0;
  };

  const parts: OverviewOutput[] = [];
  for (const [i, segments] of plan.entries()) {
    // a run in parts is minutes, not seconds, on the servers that need one — a spinner alone
    // is indistinguishable from a hang, and cancelling a working run is the cost of that
    events.overviewProgress({ recording_id: recordingId, part: i + 1, total: plan.length });
    const built = prompt.build({ ...base, segments, part: { index: i + 1, total: plan.length } });
    const part = await call(conn, built, signal);
    parts.push(part.object);
    add(part.usage);
    actualModel = part.model ?? actualModel;
  }

  const headPrompt = prompt.buildHead(parts.map((p) => p.tldr), base.role);
  const head = await askBackend({
    connection: conn,
    schema: overviewHeadSchema,
    ...headPrompt,
    abortSignal: deadline(conn, headPrompt, signal),
  });
  add(head.usage);

  return {
    object: { ...merge(parts), title: head.object.title, tldr: head.object.tldr },
    usage,
    model: head.model ?? actualModel,
  };
}

/**
 * How much transcript one request may carry. The reserve is the answer's room; the rest of
 * the built prompt is the instructions and the roster, which every window pays for again.
 */
function budgetChars(built: prompt.BuiltPrompt, contextTokens: number, reserve: number): number {
  const overhead = built.system.length + built.prompt.length - built.transcriptChars;
  return (contextTokens - reserve) * CHARS_PER_TOKEN - overhead;
}

/**
 * Sized for one whole answer first, because one call is always the better answer when it
 * fits. Once it doesn't, the reserve drops to what a part actually writes — that is worth
 * re-planning for, since every window saved is another full prompt this server won't read.
 */
function planWindows(
  lines: prompt.PromptSegment[],
  built: prompt.BuiltPrompt,
  contextTokens: number,
): prompt.PromptSegment[][] {
  const whole = windows(lines, budgetChars(built, contextTokens, OUTPUT_RESERVE_TOKENS));
  if (whole.length <= 1) return whole;
  const split = windows(lines, budgetChars(built, contextTokens, PART_RESERVE_TOKENS));
  // a single window on the smaller reserve is a single-pass call that was never sized for one
  return split.length > 1 ? split : whole;
}

/** The caller's cancel and the hard ceiling are both aborts; the call only knows about one. */
function deadline(conn: connections.Row, built: prompt.BuiltPrompt, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(conn.timeoutMs ?? allowance(built));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** What this particular prompt is worth waiting for, rather than what any prompt is. */
export function allowance(built: prompt.BuiltPrompt): number {
  const tokens = (built.system.length + built.prompt.length) / CHARS_PER_TOKEN;
  return Math.min(MIN_TIMEOUT_MS + (tokens / PROMPT_TOKENS_PER_SEC) * 1_000 + ANSWER_MS, MAX_TIMEOUT_MS);
}

/**
 * The ceiling out of an overflow 400. Both wordings in the wild name two numbers — what was
 * asked for and what was available — and the ceiling is always the smaller one:
 *   "request (8603 tokens) exceeds the available context size (8192 tokens)"
 *   "maximum context length is 8192 tokens. However, your messages resulted in 8603 tokens"
 */
export function contextLimitFrom(err: unknown): number | null {
  const text = APICallError.isInstance(err) ? `${err.message} ${err.responseBody ?? ""}` : "";
  if (!/context (?:length|size|window)/i.test(text)) return null;
  const numbers = [...text.matchAll(/\b(\d{3,8})\b/g)].map((m) => Number(m[1])).filter((n) => n >= 256);
  return numbers.length ? Math.min(...numbers) : null;
}

function classify(err: unknown): ErrorKind {
  if (err instanceof ContextError) return "too_long";
  if (contextLimitFrom(err)) return "too_long";
  // a timeout is not a cancel: nobody chose it, and the advice for it is different
  if (err instanceof Error && err.name === "TimeoutError") return "timeout";
  if (err instanceof Error && err.name === "AbortError") return "aborted";
  if (isShapeError(err)) return "validation";
  if (err instanceof CliProcessError) {
    if (/auth|log[ -]?in|credential|api key|unauthori[sz]ed|\b401\b|\b403\b/i.test(`${err.message} ${err.stderr}`)) {
      return "auth";
    }
    if (/could not start|not found|ENOENT/i.test(err.message)) return "unreachable";
    return "unknown";
  }
  if (APICallError.isInstance(err)) {
    if (err.statusCode === 401 || err.statusCode === 403) return "auth";
    if (err.statusCode === 429) return "rate_limit";
    // no status at all = the socket never got an answer, which for a local server means
    // "it isn't running" and deserves different advice than "the network is flaky"
    if (err.statusCode === undefined) return "unreachable";
    if (err.isRetryable) return "network";
    return "unknown";
  }
  if (err instanceof connections.MissingKeyError || err instanceof connections.MissingConnectionError) return "auth";
  if (err instanceof TypeError && err.message.includes("fetch")) return "unreachable";
  return "unknown";
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
