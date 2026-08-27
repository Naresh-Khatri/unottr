import {
  existsSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { err } from "../errors";

export interface SourceVersion {
  size: number;
  mtimeMs: number;
}

/** Internal control flow. A growing recording should wait, not consume a failed attempt. */
export class SourceChangedError extends Error {
  constructor(readonly path: string) {
    super(`source changed while it was being processed: ${path}`);
    this.name = "SourceChangedError";
  }
}

export function sourceVersion(path: string): SourceVersion {
  try {
    const stat = statSync(path);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch (e) {
    throw err.io(path, e);
  }
}

export const sameVersion = (a: SourceVersion, b: SourceVersion): boolean =>
  a.size === b.size && a.mtimeMs === b.mtimeMs;

export function assertSourceVersion(path: string, expected: SourceVersion): void {
  if (!sameVersion(sourceVersion(path), expected)) throw new SourceChangedError(path);
}

const metadataPath = (pcm: string): string => `${pcm}.source.json`;

/** A PCM without matching source metadata predates validation and must be regenerated. */
export function cacheMatchesSource(pcm: string, expected: SourceVersion): boolean {
  if (!existsSync(pcm)) return false;
  try {
    const parsed = JSON.parse(readFileSync(metadataPath(pcm), "utf8")) as Partial<SourceVersion>;
    return parsed.size === expected.size && parsed.mtimeMs === expected.mtimeMs;
  } catch {
    return false;
  }
}

export function markCacheSource(pcm: string, version: SourceVersion): void {
  const path = metadataPath(pcm);
  try {
    writeFileSync(path, JSON.stringify(version));
  } catch (e) {
    throw err.io(path, e);
  }
}

export function discardCachedPcm(pcm: string): void {
  for (const path of [pcm, metadataPath(pcm)]) {
    try {
      unlinkSync(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw err.io(path, e);
    }
  }
}

export interface StabilityOptions {
  pollIntervalMs: number;
  requiredCount: number;
  signal?: AbortSignal;
  onProgress?: (stable: number, required: number) => void;
}

/** Wait for consecutive identical size/mtime observations after a source-change race. */
export async function waitForStableSource(path: string, o: StabilityOptions): Promise<void> {
  let prior = sourceVersion(path);
  let stable = 0;
  o.onProgress?.(stable, o.requiredCount);
  while (stable < o.requiredCount) {
    await delay(o.pollIntervalMs, o.signal);
    const current = sourceVersion(path);
    if (sameVersion(current, prior)) stable += 1;
    else {
      prior = current;
      stable = 0;
    }
    o.onProgress?.(stable, o.requiredCount);
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(err.cancelled());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(err.cancelled());
    };
    function done(): void {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
