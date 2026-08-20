// Port of crates/unottr-core/src/model.rs — the models directory and everything that reads
// or writes it. Nothing here knows what a model is for; the registry lives in catalog.ts.

import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { err } from "../errors";
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
  signal?: AbortSignal;
}

/**
 * Download if absent, verify, and return the path. Resumes a partial `.part` file via an
 * HTTP range request. `onProgress` gets 0..1.
 */
export async function ensure(spec: ModelSpec, o: EnsureOptions = {}): Promise<string> {
  const dir = o.dir ?? modelsDir();
  const final = modelPath(spec, dir);
  if (isPresent(spec, dir)) return final;
  if (o.signal?.aborted) throw err.cancelled();

  await mkdir(dir, { recursive: true });
  const part = `${final}.part`;
  await download(spec, part, o);

  const digest = await sha256File(part);
  if (digest !== spec.sha256) {
    // a wrong file that stays on disk gets "resumed" forever; kill it now
    await rm(part, { force: true });
    throw err.download(spec.name, `checksum mismatch (got ${digest})`);
  }

  await rename(part, final);
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
    res = await fetch(url(spec), have > 0 ? { headers: { Range: `bytes=${have}-` } } : {});
  } catch (e) {
    throw err.download(spec.name, e instanceof Error ? e.message : String(e));
  }

  // 200 to a range request = server ignored it, so the bytes start at zero again
  const resuming = res.status === 206;
  if (res.status !== 200 && !resuming) throw err.download(spec.name, `http ${res.status}`);
  if (!resuming) have = 0;
  if (!res.body) throw err.download(spec.name, "empty response body");

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
