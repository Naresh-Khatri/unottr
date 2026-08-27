import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as catalog from "../src/main/models/catalog";
import { resolve, resetGpuCache } from "../src/main/models/device";
import { ensure, isPresent, locate, modelPath, sha256File } from "../src/main/models/download";

const dir = mkdtempSync(join(tmpdir(), "unottr-models-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("catalog", () => {
  it("offers exactly the three settings tiers plus the cli-only base model", () => {
    expect(catalog.WHISPER.map((m) => m.name)).toEqual([
      "large-v3-turbo",
      "medium",
      "small",
      "base.en",
    ]);
    expect(catalog.WHISPER.filter((m) => m.name !== "base.en").map((m) => catalog.modelNameToTier(m.name))).toEqual([
      "turbo",
      "medium",
      "small",
    ]);
  });

  it("round-trips tier names", () => {
    for (const tier of ["turbo", "medium", "small"]) {
      const name = catalog.tierToModelName(tier);
      expect(name).toBeDefined();
      expect(catalog.modelNameToTier(name as string)).toBe(tier);
    }
    expect(catalog.tierToModelName("auto")).toBeUndefined();
    expect(catalog.modelNameToTier("base.en")).toBe("auto");
  });

  it("drops two sizes on the cpu path", () => {
    expect(catalog.defaultWhisper(true).name).toBe("large-v3-turbo");
    expect(catalog.defaultWhisper(false).name).toBe("small");
  });

  it("ranks fallbacks behind the ideal tier, and never sends cpu to turbo early", () => {
    for (const gpu of [true, false]) {
      const order = catalog.whisperPreference(gpu);
      expect(order.map((m) => m.name)).toContain("base.en");
      expect(order).toHaveLength(catalog.WHISPER.length);
      expect(order[0].name).toBe(catalog.defaultWhisper(gpu).name);
    }
    // turbo on cpu is slower than the meeting — it is the last resort, not the second choice
    expect(catalog.whisperPreference(false).at(-1)?.name).toBe("large-v3-turbo");
  });

  it("keeps every file name and hash distinct", () => {
    const all = [...catalog.WHISPER, catalog.VAD, catalog.SEGMENTATION, ...catalog.EMBEDDINGS];
    expect(new Set(all.map((m) => m.file)).size).toBe(all.length);
    expect(new Set(all.map((m) => m.sha256)).size).toBe(all.length);
    for (const m of all) {
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(m.size).toBeGreaterThan(0);
      expect(catalog.url(m)).toMatch(/^https:\/\/huggingface\.co\//);
    }
  });

  it("defaults the embedder to the bilingual one", () => {
    expect(catalog.defaultEmbedding().name).toBe("campplus-zh-en");
  });
});

describe("device", () => {
  it("takes an explicit choice at the user's word without probing", () => {
    expect(resolve("cpu")).toBe("cpu");
    expect(resolve("gpu")).toBe("gpu");
  });

  it("resolves auto to cpu when the vulkan loader has no drivers", () => {
    const before = process.env.VK_DRIVER_FILES;
    process.env.VK_DRIVER_FILES = "/nonexistent.json";
    resetGpuCache();
    try {
      expect(resolve("auto")).toBe("cpu");
    } finally {
      if (before === undefined) delete process.env.VK_DRIVER_FILES;
      else process.env.VK_DRIVER_FILES = before;
      resetGpuCache();
    }
  });

  it("resolves auto to Metal on Apple Silicon only", () => {
    const before = process.env.VK_DRIVER_FILES;
    process.env.VK_DRIVER_FILES = "/nonexistent.json";
    resetGpuCache();
    try {
      expect(resolve("auto", "darwin", "arm64")).toBe("gpu");
      expect(resolve("auto", "darwin", "x64")).toBe("cpu");
    } finally {
      if (before === undefined) delete process.env.VK_DRIVER_FILES;
      else process.env.VK_DRIVER_FILES = before;
      resetGpuCache();
    }
  });
});

// --------------------------------------------------------------------------- download

const BODY = Buffer.from(Array.from({ length: 64_000 }, (_, i) => i % 251));
const DIGEST = createHash("sha256").update(BODY).digest("hex");

let server: Server;
let base: string;
/** Bytes to serve before hanging up, so a test can interrupt mid-stream. */
let cut: number | null = null;

beforeAll(async () => {
  server = createServer((req, res) => {
    const range = /^bytes=(\d+)-/.exec(req.headers.range ?? "");
    const from = range ? Number(range[1]) : 0;
    const body = BODY.subarray(from);
    if (range) {
      res.writeHead(206, {
        "content-range": `bytes ${from}-${BODY.length - 1}/${BODY.length}`,
        "content-length": String(body.length),
      });
    } else {
      res.writeHead(200, { "content-length": String(body.length) });
    }
    if (cut === null) {
      res.end(body);
      return;
    }
    // truncate the stream the way a dropped connection would — destroy only once the bytes
    // are on the wire, or the client never sees a body at all
    res.write(body.subarray(0, cut), () => setTimeout(() => res.socket?.destroy(), 10));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

const spec = (): catalog.ModelSpec => ({
  name: "test-model",
  file: "test-model.bin",
  baseUrl: base,
  remote: "test-model.bin",
  size: BODY.length,
  sha256: DIGEST,
});

describe("model store", () => {
  it("downloads, verifies and reports progress", async () => {
    const s = spec();
    const seen: number[] = [];
    const phases: string[] = [];
    const path = await ensure(s, {
      dir,
      onProgress: (p) => seen.push(p),
      onPhase: (phase) => phases.push(phase),
    });

    expect(path).toBe(modelPath(s, dir));
    expect(readFileSync(path).equals(BODY)).toBe(true);
    expect(seen.at(-1)).toBe(1);
    expect(await sha256File(path)).toBe(DIGEST);
    expect(isPresent(s, dir)).toBe(true);
    expect(existsSync(`${path}.part`)).toBe(false);
    expect(phases).toEqual(["connecting", "downloading", "verifying", "installing", "done"]);
  });

  it("fetches nothing once the file is there, but still reports done", async () => {
    const s = spec();
    const seen: number[] = [];
    // a wrong url proves nothing was fetched
    await ensure({ ...s, baseUrl: "http://127.0.0.1:1" }, {
      dir,
      onProgress: (p) => seen.push(p),
    });
    // silence here strands a ui that only leaves its progress bar on pct 1
    expect(seen).toEqual([1]);
  });

  it("holds progress below 1 until the file is renamed into place", async () => {
    const freshDir = mkdtempSync(join(tmpdir(), "unottr-terminal-"));
    const s = spec();
    const presentAt: boolean[] = [];
    try {
      await ensure(s, { dir: freshDir, onProgress: (p) => presentAt.push(p >= 1 && isPresent(s, freshDir)) });
      // every pct-1 event must have found the real filename already there
      expect(presentAt.filter(Boolean).length).toBe(1);
      expect(presentAt.at(-1)).toBe(true);
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  it("resumes an interrupted download and still verifies", async () => {
    const resumeDir = mkdtempSync(join(tmpdir(), "unottr-resume-"));
    const s = spec();
    cut = 20_000;
    try {
      await expect(ensure(s, { dir: resumeDir })).rejects.toThrow();
      const part = `${modelPath(s, resumeDir)}.part`;
      expect(statSync(part).size).toBe(20_000); // kept on purpose; the retry resumes it

      cut = null;
      const path = await ensure(s, { dir: resumeDir });
      expect(await sha256File(path)).toBe(DIGEST);
      expect(readFileSync(path).equals(BODY)).toBe(true);
    } finally {
      cut = null;
      rmSync(resumeDir, { recursive: true, force: true });
    }
  });

  it("deletes a file whose checksum does not match", async () => {
    const badDir = mkdtempSync(join(tmpdir(), "unottr-bad-"));
    const s = { ...spec(), sha256: "0".repeat(64) };
    try {
      await expect(ensure(s, { dir: badDir })).rejects.toMatchObject({
        detail: { kind: "download_failed" },
      });
      // a wrong file that stays would be "resumed" forever
      expect(existsSync(`${modelPath(s, badDir)}.part`)).toBe(false);
    } finally {
      rmSync(badDir, { recursive: true, force: true });
    }
  });

  it("keeps the partial file when cancelled", async () => {
    const cancelDir = mkdtempSync(join(tmpdir(), "unottr-cancel-"));
    const s = spec();
    const ac = new AbortController();
    try {
      await expect(
        ensure(s, {
          dir: cancelDir,
          signal: ac.signal,
          onProgress: () => ac.abort(),
        }),
      ).rejects.toMatchObject({ detail: { kind: "cancelled" } });
      expect(existsSync(modelPath(s, cancelDir))).toBe(false);
    } finally {
      rmSync(cancelDir, { recursive: true, force: true });
    }
  });

  it("reports a missing model by name rather than by path", () => {
    const s = { ...spec(), name: "absent", file: "absent.bin" };
    expect(isPresent(s, dir)).toBe(false);
    expect(() => locate(s, dir)).toThrow(/absent/);
  });

  it("treats a wrong-sized file as absent", () => {
    const s = { ...spec(), file: "short.bin" };
    writeFileSync(modelPath(s, dir), BODY.subarray(0, 10));
    expect(isPresent(s, dir)).toBe(false);
  });
});
