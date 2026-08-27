// "Test connection", four rungs deep. A key check alone tells you nothing useful about a
// local model: llama.cpp accepts any key, answers "hi", and then fails every structured
// generation for the rest of its life. So the ladder climbs until something breaks, and the
// rung it stopped on is what the ui shows.

import { z } from "zod";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import type { ProbeResult, ProbeRung, ProbeStep, Strategy } from "../../shared/ipc";
import type { Db } from "../db/client";
import { askBackend } from "./backend";
import { CliProcessError } from "./cli";
import { type Row, keyOf, setActiveModel, setModels, setProbe } from "./connections";
import { HttpError, chatDefault, languageModel, listModels, preset } from "./providers";
import { ask } from "./structured";

/** Reaching the endpoint should be instant; generating is where a cpu-bound model needs room. */
const REACH_MS = 8_000;
const GENERATE_MS = 90_000;

/** Deliberately trivial: this is a test of the plumbing, not of the model's judgement. */
const pingSchema = z.object({
  ok: z.boolean().describe("always true"),
  city: z.string().describe("the capital of France"),
});

const PING_SYSTEM = "You answer test questions with the requested structure and nothing else.";
const PING_PROMPT = "Set ok to true and city to the capital of France.";

/** Cheapest first — the first one that works is the one every real generation will use. */
const LADDER: Strategy[] = ["native", "json_mode", "prompted"];

export type ProbeProgress = (
  rungs: ProbeRung[],
  activeStep: ProbeStep,
  strategy: Strategy | null,
) => void;

export async function probe(
  db: Db,
  r: Row,
  signal?: AbortSignal,
  onProgress?: ProbeProgress,
): Promise<ProbeResult> {
  if (r.kind === "cli") return probeCli(db, r, signal, onProgress);
  const rungs: ProbeRung[] = [];
  const key = keyOf(r);
  const spec = preset(r.preset);
  let models: string[] = [];
  let strategy: Strategy | null = null;
  let model: string | null = r.activeModel;

  const stop = (): ProbeResult => {
    const result = { ok: rungs.every((g) => g.ok), rungs, strategy, models, model };
    setProbe(db, r.id, result, strategy);
    return result;
  };

  // 1 + 2 — the model list answers "is anything listening?" and "is this key any good?" at
  // once, and hands us the dropdown's contents on the way past.
  try {
    onProgress?.([...rungs], "reachable", null);
    models = await listModels(r.baseUrl, key, r.wire, timeout(REACH_MS, signal), r.preset);
    rungs.push({ step: "reachable", ok: true, detail: hostOf(r.baseUrl) });
    rungs.push({ step: "authorized", ok: true, detail: `${models.length} model${models.length === 1 ? "" : "s"}` });
    if (models.length) setModels(db, r.id, models);
  } catch (err) {
    if (err instanceof HttpError) {
      rungs.push({ step: "reachable", ok: true, detail: hostOf(r.baseUrl) });
      if (err.status === 401 || err.status === 403) {
        rungs.push({ step: "authorized", ok: false, detail: spec?.key_required ? "the API key was rejected" : "this endpoint wants an API key" });
        return stop();
      }
      // plenty of servers serve /v1/chat/completions and no /v1/models; that is not a failure
      rungs.push({ step: "authorized", ok: true, detail: "no model list — type the model name yourself" });
    } else {
      rungs.push({ step: "reachable", ok: false, detail: unreachableDetail(r, err) });
      return stop();
    }
  }

  const modelId = r.activeModel || chatDefault(models);
  if (!modelId) {
    rungs.push({ step: "responds", ok: false, detail: "pick a model first" });
    return stop();
  }
  // a model that just proved it works is the answer to "which one?", so stop asking
  model = modelId;
  if (!r.activeModel) setActiveModel(db, r.id, modelId);

  // 3 + 4 — one call per rung, and the first that comes back valid settles both at once:
  // an answer that matches the schema is proof the model responded.
  let lastError = "";
  for (const candidate of LADDER) {
    try {
      onProgress?.([...rungs], "responds", candidate);
      const { object } = await ask({
        model: languageModel({
          wire: r.wire,
          preset: r.preset,
          baseUrl: r.baseUrl,
          modelId,
          key,
          strategy: candidate,
        }),
        strategy: candidate,
        schema: pingSchema,
        system: PING_SYSTEM,
        prompt: PING_PROMPT,
        abortSignal: timeout(r.timeoutMs ?? GENERATE_MS, signal),
      });
      if (!object.ok) throw new Error("the model answered, but not what it was asked");
      strategy = candidate;
      rungs.push({ step: "responds", ok: true, detail: modelId });
      rungs.push({ step: "structured", ok: true, detail: LABELS[candidate] });
      return stop();
    } catch (err) {
      lastError = message(err);
      if (aborted(err)) break;
    }
  }

  // every rung failed the same way, so the honest split is: it talked (we got errors from
  // the model, not the socket) but never produced the shape.
  rungs.push({ step: "responds", ok: true, detail: modelId });
  rungs.push({ step: "structured", ok: false, detail: lastError || "the model could not produce valid JSON" });
  return stop();
}

async function probeCli(
  db: Db,
  r: Row,
  signal?: AbortSignal,
  onProgress?: ProbeProgress,
): Promise<ProbeResult> {
  const rungs: ProbeRung[] = [];
  const stop = (strategy: Strategy | null, model: string | null): ProbeResult => {
    const result = { ok: rungs.every((g) => g.ok), rungs, strategy, models: [], model };
    setProbe(db, r.id, result, strategy);
    return result;
  };

  if (!r.executablePath) {
    rungs.push({ step: "reachable", ok: false, detail: "the executable is no longer configured" });
    return stop(null, null);
  }
  try {
    onProgress?.([...rungs], "reachable", null);
    await access(r.executablePath, constants.X_OK);
    rungs.push({ step: "reachable", ok: true, detail: r.executablePath });
  } catch {
    rungs.push({ step: "reachable", ok: false, detail: "the executable was moved or removed" });
    return stop(null, null);
  }

  try {
    onProgress?.([...rungs], "responds", "native");
    const answer = await askBackend({
      connection: { ...r, strategy: "native" },
      schema: pingSchema,
      system: PING_SYSTEM,
      prompt: PING_PROMPT,
      abortSignal: timeout(r.timeoutMs ?? GENERATE_MS, signal),
    });
    rungs.push({ step: "authorized", ok: true, detail: "existing CLI login" });
    rungs.push({ step: "responds", ok: true, detail: answer.model ?? "CLI default model" });
    if (!answer.object.ok) {
      rungs.push({ step: "structured", ok: false, detail: "the agent answered, but not what it was asked" });
      return stop(null, answer.model);
    }
    rungs.push({ step: "structured", ok: true, detail: "schema enforced by the CLI" });
    return stop("native", answer.model);
  } catch (err) {
    const detail = message(err);
    if (isAuthError(err)) {
      rungs.push({ step: "authorized", ok: false, detail: "open the CLI and sign in first" });
      return stop(null, null);
    }
    rungs.push({ step: "authorized", ok: true, detail: "CLI started" });
    rungs.push({ step: "responds", ok: false, detail });
    return stop(null, null);
  }
}

const LABELS: Record<Strategy, string> = {
  native: "schema enforced by the server",
  json_mode: "JSON mode",
  prompted: "prompted JSON — slower and less reliable",
};

function timeout(ms: number, signal?: AbortSignal): AbortSignal {
  const cap = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, cap]) : cap;
}

/** "fetch failed" helps nobody; the fix is almost always "start the server" or "wrong port". */
function unreachableDetail(r: Row, err: unknown): string {
  const local = preset(r.preset)?.local;
  const base = local ? "nothing is listening — is the server running?" : "could not reach the host";
  return `${base} (${message(err)})`;
}

const aborted = (err: unknown): boolean =>
  err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const isAuthError = (err: unknown): boolean =>
  err instanceof CliProcessError &&
  /auth|log[ -]?in|credential|api key|unauthori[sz]ed|\b401\b|\b403\b/i.test(`${err.message} ${err.stderr}`);
