// Bring-your-own model: the parts that are pure enough to pin down. The url a user types,
// the rung the ladder picks, the answer packaging a small model ships, and the one-shot
// migration that carries a 0.4 key over to a connection row.

import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/main/db/client";
import { chatDefault, listModels, normalizeBaseUrl, priceOf, isLocal } from "../src/main/ai/providers";
import { ask, loosely } from "../src/main/ai/structured";
import { merge, windows } from "../src/main/ai/split";
import { allowance, contextLimitFrom } from "../src/main/ai/generate";
import * as promptBuilder from "../src/main/ai/prompt";
import { APICallError } from "ai";
import { type OverviewOutput, overviewExample, overviewSchema } from "../src/main/ai/schema";
import { z } from "zod";
import * as connections from "../src/main/ai/connections";
import { parseClaude, parseCodex } from "../src/main/ai/cli";

// nothing here touches a key, so the only thing electron is asked for is its absence
vi.mock("electron", () => ({ safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => "" } }));

describe("normalizeBaseUrl", () => {
  it("takes a bare loopback host to an http /v1 root", () => {
    expect(normalizeBaseUrl("localhost:11434")).toBe("http://localhost:11434/v1");
    expect(normalizeBaseUrl("127.0.0.1:1234")).toBe("http://127.0.0.1:1234/v1");
  });

  it("only assumes https for a bare public host, never for loopback", () => {
    expect(normalizeBaseUrl("api.openai.com")).toBe("https://api.openai.com/v1");
    expect(normalizeBaseUrl("http://api.openai.com/v1")).toBe("http://api.openai.com/v1");
  });

  it("strips the endpoint people paste out of a curl example", () => {
    expect(normalizeBaseUrl("http://localhost:11434/v1/chat/completions")).toBe(
      "http://localhost:11434/v1",
    );
    expect(normalizeBaseUrl("https://api.anthropic.com/v1/messages")).toBe(
      "https://api.anthropic.com/v1",
    );
  });

  it("takes ollama's native root to its openai-compatible one", () => {
    expect(normalizeBaseUrl("http://localhost:11434/api")).toBe("http://localhost:11434/v1");
  });

  it("leaves a path that is already right alone, trailing slash and all", () => {
    expect(normalizeBaseUrl("https://openrouter.ai/api/v1/")).toBe("https://openrouter.ai/api/v1");
  });
});

describe("isLocal", () => {
  it("is about the host, not the scheme", () => {
    expect(isLocal("http://127.0.0.1:1234/v1")).toBe(true);
    expect(isLocal("http://[::1]:11434/v1")).toBe(true);
    expect(isLocal("https://api.mistral.ai/v1")).toBe(false);
  });
});

describe("priceOf", () => {
  it("falls back to the family when the id carries a date suffix", () => {
    expect(priceOf("gpt-4o-2024-11-20", false)).toEqual(priceOf("gpt-4o", false));
  });

  it("prices anything served locally at nothing, known id or not", () => {
    expect(priceOf("qwen3:8b", true)).toBeNull();
    expect(priceOf("gpt-4o", true)).toBeNull();
  });

  it("leaves an unknown hosted model unpriced rather than guessing", () => {
    expect(priceOf("some-fine-tune-v2", false)).toBeNull();
  });
});

// ------------------------------------------------------------------------------- the ladder

const pingSchema = z.object({ ok: z.boolean() });

/** Captures the system prompt the rung actually sent, which is the whole difference between them. */
function spy(text: string) {
  const seen: { system?: string } = {};
  const model = new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      seen.system = prompt.find((m) => m.role === "system")?.content as string | undefined;
      return {
        content: [{ type: "text" as const, text }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: {
          inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: 5, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
  return { model, seen };
}

describe("listModels", () => {
  /** One canned reply per url, so the lm-studio two-hop can be told apart from the plain one. */
  function serve(routes: Record<string, unknown>) {
    return vi.fn(async (url: string) => {
      const body = routes[url];
      if (body === undefined) return new Response("nope", { status: 404 });
      return new Response(JSON.stringify(body), { status: 200 });
    });
  }

  const openaiShape = (...ids: string[]) => ({ data: ids.map((id) => ({ id })) });

  afterEach(() => vi.unstubAllGlobals());

  it("keeps the server's order instead of sorting — alphabetical is how a picker lands on an image model", async () => {
    vi.stubGlobal("fetch", serve({
      "http://x/v1/models": openaiShape("zephyr", "alpha", "mistral"),
    }));
    expect(await listModels("http://x/v1", null, "openai")).toEqual(["zephyr", "alpha", "mistral"]);
  });

  it("sinks the models no chat will ever come out of, without hiding them", async () => {
    vi.stubGlobal("fetch", serve({
      "http://x/v1/models": openaiShape("text-embedding-3-small", "flux2-klein", "gpt-4o"),
    }));
    expect(await listModels("http://x/v1", null, "openai")).toEqual([
      "gpt-4o",
      "text-embedding-3-small",
      "flux2-klein",
    ]);
  });

  it("asks LM Studio which model is loaded, since /v1/models will not say", async () => {
    vi.stubGlobal("fetch", serve({
      "http://localhost:1234/api/v0/models": {
        data: [
          { id: "flux2-klein", type: "llm", state: "not-loaded" },
          { id: "nomic-embed", type: "embeddings", state: "not-loaded" },
          { id: "qwen-vl", type: "vlm", state: "not-loaded" },
          { id: "gpt-oss-20b", type: "llm", state: "loaded" },
        ],
      },
    }));
    // loaded first, embeddings gone, image model last — and vlm kept, because it chats fine
    expect(await listModels("http://localhost:1234/v1", null, "openai", undefined, "lm-studio")).toEqual([
      "gpt-oss-20b",
      "qwen-vl",
      "flux2-klein",
    ]);
  });

  it("falls back to the openai list when LM Studio's own api is not there", async () => {
    vi.stubGlobal("fetch", serve({ "http://localhost:1234/v1/models": openaiShape("gpt-oss-20b") }));
    expect(await listModels("http://localhost:1234/v1", null, "openai", undefined, "lm-studio")).toEqual([
      "gpt-oss-20b",
    ]);
  });
});

describe("chatDefault", () => {
  it("never offers an embedding model as the one to generate with", () => {
    expect(chatDefault(["text-embedding-3-small", "gpt-4o"])).toBe("gpt-4o");
  });

  it("would rather guess than refuse when everything looks wrong", () => {
    expect(chatDefault(["text-embedding-3-small"])).toBe("text-embedding-3-small");
    expect(chatDefault([])).toBeUndefined();
  });
});

describe("ask", () => {
  it("says nothing about the shape on the native rung — the request already carries it", async () => {
    const { model, seen } = spy('{"ok":true}');
    await ask({ model, strategy: "native", schema: pingSchema, system: "S", prompt: "P" });
    expect(seen.system).toBe("S");
  });

  it("puts the schema in the prompt on every rung below native", async () => {
    for (const strategy of ["json_mode", "prompted"] as const) {
      const { model, seen } = spy('{"ok":true}');
      await ask({ model, strategy, schema: pingSchema, system: "S", prompt: "P" });
      expect(seen.system).toContain('"properties"');
      expect(seen.system).toContain("ok");
    }
  });

  it("shows a worked example when one is offered", async () => {
    const { model, seen } = spy(JSON.stringify(overviewExample));
    const { object } = await ask({
      model,
      strategy: "prompted",
      schema: overviewSchema,
      example: overviewExample,
      system: "S",
      prompt: "P",
    });
    expect(seen.system).toContain("Pricing page rewrite");
    expect(object.title).toBe("Pricing page rewrite");
  });

  it("unwraps a fenced, chatty answer on the prompted rung", async () => {
    const { model } = spy('Sure! Here you go:\n```json\n{"ok": true}\n```\nHope that helps.');
    const { object } = await ask({ model, strategy: "prompted", schema: pingSchema, system: "S", prompt: "P" });
    expect(object).toEqual({ ok: true });
  });
});

describe("loosely", () => {
  it("forgives a trailing comma", () => {
    expect(loosely('{"a": 1,}')).toEqual({ a: 1 });
  });

  it("refuses prose that contains no object at all", () => {
    expect(() => loosely("I'm afraid I can't do that.")).toThrow(/no JSON object/);
  });
});

describe("installed agent output", () => {
  it("reads Claude's schema result, actual model, and usage", () => {
    const answer = parseClaude(JSON.stringify({
      structured_output: { ok: true },
      usage: { input_tokens: 42, output_tokens: 7 },
      modelUsage: { "claude-sonnet-4-6": { inputTokens: 42, outputTokens: 7 } },
    }), pingSchema);
    expect(answer).toEqual({
      object: { ok: true },
      usage: { inputTokens: 42, outputTokens: 7 },
      model: "claude-sonnet-4-6",
    });
  });

  it("reads Codex's final JSONL answer and turn usage", () => {
    const answer = parseCodex([
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '{"ok":true}' } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 30, output_tokens: 4 } }),
    ].join("\n"), pingSchema, null);
    expect(answer).toEqual({
      object: { ok: true },
      usage: { inputTokens: 30, outputTokens: 4 },
      model: null,
    });
  });
});

// ---------------------------------------------------------------------------- the migration

const MIGRATIONS = resolve(import.meta.dirname, "../drizzle");

/** Migrate to a chosen point by handing drizzle a folder whose journal stops there. */
function migrateTo(db: ReturnType<typeof openDatabase>, upto: number, dir: string): void {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta/_journal.json"), "utf8"));
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= upto);
  writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify(journal));
  migrate(db, { migrationsFolder: dir });
}

describe("0005_ai_providers", () => {
  function stage() {
    const dir = mkdtempSync(join(tmpdir(), "unottr-mig-"));
    mkdirSync(join(dir, "meta"), { recursive: true });
    cpSync(MIGRATIONS, dir, { recursive: true });
    const db = openDatabase(join(dir, "test.db"));
    migrateTo(db, 4, dir);
    return { db, dir };
  }

  it("lifts a configured mistral key into a connection and activates it", () => {
    const { db, dir } = stage();
    db.$client.exec(`INSERT INTO settings (key, value) VALUES
      ('mistral_api_key_enc', 'ZW5jcnlwdGVk'),
      ('ai_model', 'mistral-small-2506'),
      ('ai_consented', '1'),
      ('ai_spend_cents', '42.5')`);

    migrateTo(db, 5, dir);

    const row = db.$client.prepare("SELECT * FROM ai_connections").get() as Record<string, unknown>;
    expect(row).toMatchObject({
      label: "Mistral",
      wire: "mistral",
      key_enc: "ZW5jcnlwdGVk",
      active_model: "mistral-small-2506",
      consented: 1,
      spend_cents: 42.5,
      strategy: "native",
    });

    const active = db.$client
      .prepare("SELECT value FROM settings WHERE key = 'ai_active_connection_id'")
      .get() as { value: string };
    expect(Number(active.value)).toBe(row.id);

    // the old keys are gone, not merely ignored — two places to look is one too many
    const leftovers = db.$client
      .prepare(
        `SELECT count(*) AS n FROM settings WHERE key IN
         ('ai_model','ai_consented','ai_spend_cents','mistral_api_key_enc','mistral_api_key_plain')`,
      )
      .get() as { n: number };
    expect(leftovers.n).toBe(0);
  });

  it("creates nothing when no key was ever configured", () => {
    const { db, dir } = stage();
    db.$client.exec("INSERT INTO settings (key, value) VALUES ('ai_model', 'mistral-large-2512')");

    migrateTo(db, 5, dir);

    const { n } = db.$client.prepare("SELECT count(*) AS n FROM ai_connections").get() as { n: number };
    expect(n).toBe(0);
  });
});

describe("connection labels", () => {
  function fresh() {
    const dir = mkdtempSync(join(tmpdir(), "unottr-conn-"));
    const db = openDatabase(join(dir, "test.db"));
    migrate(db, { migrationsFolder: MIGRATIONS });
    return db;
  }

  it("numbers a second connection on the same preset, so the list can be chosen from", () => {
    const db = fresh();
    const a = connections.save(db, { preset: "lm-studio", base_url: "http://localhost:1234/v1" });
    const b = connections.save(db, { preset: "lm-studio", base_url: "http://localhost:4321/v1" });
    expect(a.label).toBe("LM Studio");
    expect(b.label).toBe("LM Studio 2");
    // editing one must not renumber it against itself
    expect(connections.save(db, { id: b.id, base_url: "http://localhost:4322/v1" }).label).toBe("LM Studio 2");
  });

  it("leaves a name the user typed alone", () => {
    const db = fresh();
    connections.save(db, { preset: "lm-studio", base_url: "http://localhost:1234/v1" });
    const mine = connections.save(db, { preset: "lm-studio", base_url: "http://localhost:4321/v1", label: "LM Studio" });
    expect(mine.label).toBe("LM Studio");
  });

  it("stores installed agents separately from HTTP endpoints and accepts only an HTTP fallback", () => {
    const db = fresh();
    const claude = connections.save(db, { preset: "claude-code", executable_path: "/bin/true" });
    const api = connections.save(db, { preset: "anthropic", base_url: "https://api.anthropic.com/v1" });

    expect(claude).toMatchObject({
      kind: "cli",
      executable_path: "/bin/true",
      base_url: "",
      subscription_managed: true,
    });
    connections.setFallback(db, api.id);
    expect(connections.settings(db).fallback_connection_id).toBe(api.id);
    expect(() => connections.setFallback(db, claude.id)).toThrow(/HTTP API connection/);
  });
});

describe("windows", () => {
  const line = (id: number, text: string) => ({ id, text, speakerId: 1 });
  // `windows` charges LINE_OVERHEAD (32) per line on top of the text
  const seg = (id: number) => line(id, "x".repeat(68)); // 100 chars all in

  it("fills each window to the budget and no further", () => {
    // budget 250 leaves no room for an overlap that would be 40% of the next window
    expect(windows([1, 2, 3, 4, 5].map(seg), 250).map((w) => w.map((s) => s.id))).toEqual([
      [1, 2],
      [3, 4],
      [5],
    ]);
  });

  it("carries the boundary over when there is room to", () => {
    expect(windows([1, 2, 3, 4, 5, 6, 7].map(seg), 500).map((w) => w.map((s) => s.id))).toEqual([
      [1, 2, 3, 4, 5],
      [5, 6, 7],
    ]);
  });

  it("keeps a whole segment even when it alone busts the budget", () => {
    const out = windows([line(1, "short"), line(2, "y".repeat(500))], 200);
    expect(out.at(-1)?.map((s) => s.text.length)).toContain(500);
    expect(out.flat().filter((s) => s.id === 2)).toHaveLength(1);
  });

  it("has nothing to say about an impossible budget", () => {
    expect(windows([seg(1)], 0)).toEqual([]);
    expect(windows([], 1000)).toEqual([]);
  });
});

describe("merge", () => {
  const empty = (): OverviewOutput => ({ title: "t", tldr: "d", sections: [], decisions: [], tasks: [] });
  const part = (over: Partial<OverviewOutput>): OverviewOutput => ({ ...empty(), ...over });
  const task = (id: number) => ({ text: `do ${id}`, owner_speaker_id: 1, segment_id: id, due_raw: "", due_date: "" });

  it("keeps the meeting's order and drops what the overlap said twice", () => {
    const out = merge([
      part({
        sections: [{ heading: "One", bullets: [{ text: "a", segment_id: 1 }, { text: "b", segment_id: 2 }] }],
        tasks: [task(2)],
        decisions: [{ text: "d", segment_id: 2 }],
      }),
      part({
        // segment 2 is the overlap: the same line, summarized again
        sections: [{ heading: "Two", bullets: [{ text: "b again", segment_id: 2 }, { text: "c", segment_id: 3 }] }],
        tasks: [task(2), task(3)],
        decisions: [{ text: "d again", segment_id: 2 }],
      }),
    ]);
    expect(out.sections.map((s) => s.heading)).toEqual(["One", "Two"]);
    expect(out.sections[1].bullets.map((b) => b.segment_id)).toEqual([3]);
    expect(out.tasks.map((t) => t.segment_id)).toEqual([2, 3]);
    expect(out.decisions).toHaveLength(1);
    // the two whole-meeting fields are nobody's window to answer
    expect(out.title).toBe("");
    expect(out.tldr).toBe("");
  });

  it("drops a heading whose every bullet was already said", () => {
    const one = { heading: "One", bullets: [{ text: "a", segment_id: 1 }] };
    expect(merge([part({ sections: [one] }), part({ sections: [one] })]).sections).toHaveLength(1);
  });
});

describe("contextLimitFrom", () => {
  const err = (message: string) =>
    new APICallError({ message, url: "http://localhost:1234/v1/chat/completions", requestBodyValues: {}, statusCode: 400 });

  it("takes the ceiling, not the request, out of either wording", () => {
    expect(contextLimitFrom(err("request (8603 tokens) exceeds the available context size (8192 tokens)"))).toBe(8192);
    expect(
      contextLimitFrom(err("This model's maximum context length is 8192 tokens. However, your messages resulted in 8603 tokens")),
    ).toBe(8192);
  });

  it("stays out of the way of every other 400", () => {
    expect(contextLimitFrom(err("model 'gpt-4' not found"))).toBeNull();
    expect(contextLimitFrom(new Error("context length is 8192"))).toBeNull();
  });
});

describe("allowance", () => {
  const built = (chars: number) => ({
    system: "",
    prompt: "x".repeat(chars),
    transcriptChars: chars,
    speakerIds: new Map(),
  }) as unknown as promptBuilder.BuiltPrompt;

  it("gives a full window long enough to be read at all", () => {
    // the run that started this: ~3,900 tokens at 27 tok/s is 145s of prompt processing
    // before a single token of answer exists, and the old flat ceiling was 120s
    expect(allowance(built(3_900 * 4))).toBeGreaterThan(300_000);
  });

  it("does not wait forever for a transcript nothing could read", () => {
    expect(allowance(built(10_000_000))).toBe(20 * 60_000);
  });
});

describe("prompt.build", () => {
  const input = { cast: [], segments: [{ id: 1, text: "hello", speakerId: null }], role: null, recordedAt: null, pseudonymize: false };

  it("tells a window it is one, and says nothing when the whole thing fits", () => {
    expect(promptBuilder.build({ ...input, part: { index: 2, total: 3 } }).prompt).toContain("part 2 of 3");
    expect(promptBuilder.build(input).prompt).not.toContain("part 1 of");
  });

  it("measures the transcript apart from the instructions around it", () => {
    const built = promptBuilder.build(input);
    expect(built.transcriptChars).toBeLessThan(built.prompt.length);
    expect(built.transcriptChars).toBeGreaterThan("hello".length);
  });
});
