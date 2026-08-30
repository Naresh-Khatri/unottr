// Port of crates/unottr-core/src/model.rs — the models directory and everything that reads
// or writes it. Nothing here knows what a model is for; the registry lives in catalog.ts.

import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { err } from "../errors";
import type { ModelDownloadPhase } from "../../shared/ipc";
import { modelsDir } from "../paths";
import type { ModelSpec } from "./catalog";
import { url } from "./catalog";

export const modelPath = (spec: ModelSpec, dir: string = modelsDir()): string =>
  join(dir, spec.file);

/** Cheap presence check — size only. `ensure` is what verifies the hash. */
export function isPresent(spec: ModelSpec, dir: string = modelsDir()): boolean {
  try {
    return statSync(modelPath(spec, dir)).size === spec.size;
  } catch {
    return false;
  }
}

/**
 * Path to an already-downloaded model, or `model_missing` so the ui can offer to fetch it.
 * Never downloads — callers that may block go through `ensure`.
 */
export function locate(spec: ModelSpec, dir: string = modelsDir()): string {
  if (isPresent(spec, dir)) return modelPath(spec, dir);
  throw err.modelMissing(spec.name);
}

export interface EnsureOptions {
  dir?: string;
  onProgress?: (pct: number) => void;
  onPhase?: (phase: ModelDownloadPhase) => void;
  signal?: AbortSignal;
}

/**
 * Download if absent, verify, and return the path. Resumes a partial `.part` file via an
 * HTTP range request. `onProgress` gets 0..1.
 */
export async function ensure(spec: ModelSpec, o: EnsureOptions = {}): Promise<string> {
  const dir = o.dir ?? modelsDir();
  const final = modelPath(spec, dir);
  // 1 must mean "on disk under its real name", so streaming stops short of it — hashing a
  // 500 MB file takes seconds, and a ui that refreshes at the last byte still sees `.part`
  const streaming = o.onProgress && ((pct: number) => o.onProgress?.(Math.min(pct, 0.999)));

  if (isPresent(spec, dir)) {
    // nothing to do, but still report done — silence here hangs a caller waiting on progress
    o.onProgress?.(1);
    o.onPhase?.("done");
    return final;
  }
  if (o.signal?.aborted) throw err.cancelled();

  await mkdir(dir, { recursive: true });
  const part = `${final}.part`;
  let completePart = false;
  try {
    completePart = statSync(part).size === spec.size;
  } catch {
    completePart = false;
  }
  if (!completePart) await download(spec, part, { ...o, onProgress: streaming });

  o.onPhase?.("verifying");
  const digest = await sha256File(part);
  if (digest !== spec.sha256) {
    // a wrong file that stays on disk gets "resumed" forever; kill it now
    await rm(part, { force: true });
    throw err.download(spec.name, `checksum mismatch (got ${digest})`);
  }

  o.onPhase?.("installing");
  await rename(part, final);
  o.onProgress?.(1);
  o.onPhase?.("done");
  return final;
}

async function download(spec: ModelSpec, part: string, o: EnsureOptions): Promise<void> {
  let have = 0;
  try {
    const size = statSync(part).size;
    // longer than expected = not our file; start over
    have = size > spec.size ? 0 : size;
  } catch {
    have = 0;
  }

  let res: Response;
  try {
    o.onPhase?.("connecting");
    res = await fetch(url(spec), {
      headers: have > 0 ? { Range: `bytes=${have}-` } : undefined,
      signal: o.signal,
    });
  } catch (e) {
    if (o.signal?.aborted) throw err.cancelled();
    throw err.download(spec.name, e instanceof Error ? e.message : String(e));
  }

  // 200 to a range request = server ignored it, so the bytes start at zero again
  const resuming = res.status === 206;
  if (res.status !== 200 && !resuming) throw err.download(spec.name, `http ${res.status}`);
  if (resuming && !res.headers.get("content-range")?.startsWith(`bytes ${have}-`)) {
    throw err.download(spec.name, "invalid content-range for resumed download");
  }
  if (!resuming) have = 0;
  if (!res.body) throw err.download(spec.name, "empty response body");
  o.onPhase?.("downloading");

  const file = await open(part, have > 0 ? "r+" : "w");
  let written = have;
  try {
    await file.truncate(have);
    o.onProgress?.(fraction(written, spec.size));

    const reader = res.body.getReader();
    for (;;) {
      if (o.signal?.aborted) {
        // partial file is kept on purpose; the next run resumes it
        await reader.cancel().catch(() => {});
        throw err.cancelled();
      }
      const { done, value } = await reader.read();
      if (done) break;
      await file.write(value, 0, value.byteLength, written);
      written += value.byteLength;
      o.onProgress?.(fraction(written, spec.size));
    }
  } finally {
    await file.close();
  }

  if (written !== spec.size) {
    throw err.download(spec.name, `expected ${spec.size} bytes, got ${written}`);
  }
}

const fraction = (done: number, total: number): number =>
  total === 0 ? 1 : Math.min(1, Math.max(0, done / total));

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", (e) => reject(err.io(path, e)));
    stream.on("data", (c) => hash.update(c));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
