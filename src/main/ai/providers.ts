// What we know about endpoints: the presets the ui offers, how to turn a connection into a
// language model, and what a typed base url probably meant. No key custody here — that is
// connections.ts, and this file never touches the database.

import { createAnthropic } from "@ai-sdk/anthropic";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { AiPreset, Strategy, Wire } from "../../shared/ipc";

/**
 * Ollama first: most people adding a model here are running one locally, and the whole point
 * of the add flow is that they paste a url rather than shop for a vendor. `custom` is last
 * and openai-wire, because every self-hosted server that isn't Anthropic speaks that dialect
 * and a url cannot tell you otherwise.
 */
export const PRESETS: AiPreset[] = [
  {
    id: "ollama",
    label: "Ollama",
    base_url: "http://localhost:11434/v1",
    wire: "openai",
    key_required: false,
    docs_url: "https://ollama.com/download",
    local: true,
  },
  {
    id: "lm-studio",
    label: "LM Studio",
    base_url: "http://localhost:1234/v1",
    wire: "openai",
    key_required: false,
    docs_url: "https://lmstudio.ai/docs/app/api",
    local: true,
  },
  {
    id: "openai",
    label: "OpenAI",
    base_url: "https://api.openai.com/v1",
    wire: "openai",
    key_required: true,
    docs_url: "https://platform.openai.com/api-keys",
    local: false,
  },
  {
    id: "anthropic",
    label: "Anthropic",
    base_url: "https://api.anthropic.com/v1",
    wire: "anthropic",
    key_required: true,
    docs_url: "https://console.anthropic.com/settings/keys",
    local: false,
  },
  {
    id: "mistral",
    label: "Mistral",
    base_url: "https://api.mistral.ai/v1",
    wire: "mistral",
    key_required: true,
    docs_url: "https://console.mistral.ai/api-keys",
    local: false,
  },
  {
    id: "custom",
    label: "Other (OpenAI-compatible)",
    base_url: "",
    wire: "openai",
    key_required: false,
    docs_url: null,
    local: false,
  },
];

export const preset = (id: string): AiPreset | undefined => PRESETS.find((p) => p.id === id);

/** The two servers worth knocking on before the user has typed anything (decision #41). */
export const LOCAL_SCAN = ["ollama", "lm-studio"] as const;

/**
 * USD per million tokens, in/out. Only a starting point — every field is editable, because
 * this table is stale the week after it is written and a wrong number shown confidently is
 * worse than an empty one the user filled in.
 */
const PRICES: Record<string, [number, number]> = {
  "gpt-4o": [2.5, 10],
  "gpt-4o-mini": [0.15, 0.6],
  "gpt-4.1": [2, 8],
  "gpt-4.1-mini": [0.4, 1.6],
  "claude-sonnet-4-5": [3, 15],
  "claude-haiku-4-5": [1, 5],
  "claude-opus-4-1": [15, 75],
  "mistral-large-2512": [0.5, 1.5],
  "mistral-small-2506": [0.1, 0.3],
};

/** Local servers are free; for everything else an unknown model means "don't guess". */
export function priceOf(modelId: string | null, local: boolean): [number, number] | null {
  if (local) return null;
  if (!modelId) return null;
  const exact = PRICES[modelId];
  if (exact) return exact;
  // vendors suffix a date ("gpt-4o-2024-11-20"); the family price is the right default
  const family = Object.keys(PRICES).find((id) => modelId.startsWith(`${id}-`));
  return family ? PRICES[family] : null;
}

// ------------------------------------------------------------------------------------ url

const LOOPBACK = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

/** Loopback -> the transcript never leaves the machine, so the consent copy has to differ. */
export function isLocal(baseUrl: string): boolean {
  try {
    return LOOPBACK.has(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * What the user meant by what they pasted. People copy the endpoint out of a curl example,
 * or type a bare `localhost:11434` — both are the right answer to "where is your server?"
 * and neither is a base url. Left alone otherwise: guessing beyond this is how you break
 * a proxy that genuinely lives at /api/openai.
 */
export function normalizeBaseUrl(input: string): string {
  const raw = input.trim();
  if (!raw) return "";
  const bare = !/^https?:\/\//i.test(raw);

  let parsed: URL;
  try {
    parsed = new URL(bare ? `http://${raw}` : raw);
  } catch {
    return raw;
  }
  // a bare hostname with no port is a public api -> https. An explicit port is somebody's
  // own box on the lan, which is plain http far more often than not.
  if (bare && !parsed.port && !LOOPBACK.has(parsed.hostname)) parsed.protocol = "https:";

  let path = parsed.pathname.replace(/\/+$/, "");
  for (const tail of ["/chat/completions", "/completions", "/api/chat", "/messages"]) {
    if (path.endsWith(tail)) {
      path = path.slice(0, -tail.length);
      break;
    }
  }
  // ollama's native api and its openai shim share a host; only the shim speaks our dialect
  if (path === "/api") path = "/v1";
  if (path === "") path = "/v1"; // every wire we speak, anthropic included, is versioned

  return `${parsed.origin}${path}`;
}

// ---------------------------------------------------------------------------------- model

export interface ModelSpec {
  wire: Wire;
  preset: string;
  baseUrl: string;
  modelId: string;
  key: string | null;
  strategy: Strategy;
}

/**
 * `native` is the only rung that changes the *request*: it asks for a json_schema
 * response_format. The other two are prompt-side, so they build the same model with
 * structured outputs off and let generate.ts do the asking.
 */
export function languageModel(spec: ModelSpec): LanguageModel {
  const apiKey = spec.key ?? "";
  switch (spec.wire) {
    case "anthropic":
      return createAnthropic({ apiKey, baseURL: spec.baseUrl })(spec.modelId);
    case "mistral":
      return createMistral({ apiKey, baseURL: spec.baseUrl })(spec.modelId);
    default:
      if (spec.preset === "openai") return createOpenAI({ apiKey, baseURL: spec.baseUrl })(spec.modelId);
      return createOpenAICompatible({
        name: spec.preset,
        baseURL: spec.baseUrl,
        // openai-compatible servers reject an unexpected auth header far more often than
        // they demand one; only send it when there is something to send
        apiKey: apiKey || undefined,
        supportsStructuredOutputs: spec.strategy === "native",
      }).chatModel(spec.modelId);
  }
}

/** Names that no chat completion will ever come out of. Used to pick a default, never to hide a row. */
const NOT_CHAT = /(^|[-/_])(embed|embedding|rerank|reranker|whisper|tts|stable-diffusion|sdxl|flux|wan\d)/i;

/**
 * GET the model list. Every wire publishes one at the same place except Anthropic's, which…
 * also does. Returned in the server's own order, never sorted: "first" is a claim these
 * servers make on purpose (loaded first, newest first) and alphabetical throws it away —
 * which is how a picker lands on someone's image model.
 */
export async function listModels(
  baseUrl: string,
  key: string | null,
  wire: Wire,
  signal?: AbortSignal,
  presetId?: string,
): Promise<string[]> {
  if (presetId === "lm-studio") {
    const rich = await lmStudioModels(baseUrl, signal);
    if (rich) return rich;
  }
  const res = await fetch(`${baseUrl}/models`, { headers: authHeaders(key, wire), signal });
  if (!res.ok) throw new HttpError(res.status, await text(res));
  const body = (await res.json()) as { data?: { id?: string }[]; models?: { name?: string }[] };
  const ids = (body.data ?? []).map((m) => m.id).concat((body.models ?? []).map((m) => m.name));
  return chatFirst(ids.filter((id): id is string => typeof id === "string" && id.length > 0));
}

/** Stable partition, so the head of the list is always something you could chat with. */
const chatFirst = (ids: string[]): string[] => [
  ...ids.filter((id) => !NOT_CHAT.test(id)),
  ...ids.filter((id) => NOT_CHAT.test(id)),
];

/**
 * LM Studio's /v1/models lists everything downloaded — embeddings, image models, the lot —
 * with no way to tell them apart. Its own /api/v0 says which are `llm` and which are loaded,
 * and the loaded one is what the user means by "my model". Best-effort: null falls back.
 */
async function lmStudioModels(baseUrl: string, signal?: AbortSignal): Promise<string[] | null> {
  try {
    const res = await fetch(`${new URL(baseUrl).origin}/api/v0/models`, { signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: LmStudioModel[] };
    // deny, don't allow: "vlm" chats perfectly well, and the next type they add probably will too
    const llms = (body.data ?? []).filter((m) => typeof m.id === "string" && m.type !== "embeddings");
    if (!llms.length) return null;
    // loaded beats plausible-looking: a model already in VRAM is what the user meant
    const ids = (state: (s?: string) => boolean) =>
      chatFirst(llms.filter((m) => state(m.state)).map((m) => m.id as string));
    return [...ids((s) => s === "loaded"), ...ids((s) => s !== "loaded")];
  } catch {
    return null;
  }
}

/**
 * How much context this endpoint will actually give us for `modelId`, or null if it will not
 * say. Only LM Studio answers today, and only it can: `loaded_context_length` is the size the
 * running instance was started with, which is the number that decides whether a request fits
 * — `max_context_length` is what the weights allow and is routinely 16x larger.
 */
export async function modelContext(
  baseUrl: string,
  modelId: string,
  presetId: string,
  signal?: AbortSignal,
): Promise<number | null> {
  if (presetId !== "lm-studio") return null;
  try {
    const res = await fetch(`${new URL(baseUrl).origin}/api/v0/models`, { signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: LmStudioModel[] };
    const found = (body.data ?? []).find((m) => m.id === modelId);
    const n = found?.loaded_context_length ?? found?.max_context_length;
    return typeof n === "number" && n > 0 ? n : null;
  } catch {
    return null;
  }
}

interface LmStudioModel {
  id?: string;
  type?: string;
  state?: string;
  max_context_length?: number;
  loaded_context_length?: number;
}

/** The model to offer when the user has not chosen one. First is right far more often than not. */
export function chatDefault(ids: string[]): string | undefined {
  return ids.find((id) => !NOT_CHAT.test(id)) ?? ids[0];
}

export function authHeaders(key: string | null, wire: Wire): Record<string, string> {
  if (!key) return {};
  if (wire === "anthropic") return { "x-api-key": key, "anthropic-version": "2023-06-01" };
  return { authorization: `Bearer ${key}` };
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(body ? `HTTP ${status}: ${body.slice(0, 200)}` : `HTTP ${status}`);
  }
}

const text = async (res: Response): Promise<string> => {
  try {
    return (await res.text()).trim();
  } catch {
    return "";
  }
};
