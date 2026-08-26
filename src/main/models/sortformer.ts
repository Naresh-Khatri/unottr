import { existsSync, statSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { QVACRegistryClient } from "@qvac/registry-client";
import { err } from "../errors";
import { modelsDir } from "../paths";
import { sha256File } from "./download";

export const SORTFORMER = {
  name: "sortformer-4spk-v2.1-q8",
  file: "diar_streaming_sortformer_4spk-v2.1.q8_0.gguf",
  size: 140_717_952,
  sha256: "1d593b947fbf5dca16f6d17266e4c587f01fb265994b2612783287c5cd735d15",
  registryPath:
    "qvac_models_compiled/ggml/parakeet/2026-05-20/" +
    "diar_streaming_sortformer_4spk-v2.1.q8_0.gguf",
  registrySource: "s3",
} as const;

export const sortformerModelPath = (dir: string = modelsDir()): string =>
  join(dir, SORTFORMER.file);

export function isSortformerPresent(dir: string = modelsDir()): boolean {
  try {
    return statSync(sortformerModelPath(dir)).size === SORTFORMER.size;
  } catch {
    return false;
  }
}

export interface EnsureSortformerOptions {
  dir?: string;
  onProgress?: (pct: number) => void;
  signal?: AbortSignal;
}

/** Download the QVAC-built GGUF. The registry stream is content-addressed; we still hash it. */
export async function ensureSortformer(o: EnsureSortformerOptions = {}): Promise<string> {
  const dir = o.dir ?? modelsDir();
  const final = sortformerModelPath(dir);
  if (isSortformerPresent(dir)) {
    o.onProgress?.(1);
    return final;
  }
  if (o.signal?.aborted) throw err.cancelled();

  await mkdir(dir, { recursive: true });
  const part = `${final}.part`;
  const client = new QVACRegistryClient();
  try {
    await client.ready();
    await client.downloadModel(SORTFORMER.registryPath, SORTFORMER.registrySource, {
      outputFile: part,
      timeout: 600_000,
      signal: o.signal,
      onProgress: ({ downloaded, total }) => {
        o.onProgress?.(total > 0 ? Math.min(0.999, downloaded / total) : 0);
      },
    });
  } catch (e) {
    if (o.signal?.aborted) throw err.cancelled();
    throw err.download(SORTFORMER.name, e instanceof Error ? e.message : String(e));
  } finally {
    await client.close().catch(() => {});
  }

  const size = statSync(part).size;
  const digest = await sha256File(part);
  if (size !== SORTFORMER.size || digest !== SORTFORMER.sha256) {
    await rm(part, { force: true });
    throw err.download(
      SORTFORMER.name,
      `verification failed (expected ${SORTFORMER.size} bytes and ${SORTFORMER.sha256})`,
    );
  }

  await rename(part, final);
  o.onProgress?.(1);
  return final;
}

/** Packaged and local-development locations for the staged CLI. */
export function sortformerRuntime(): string | null {
  const override = process.env.UNOTTR_SORTFORMER;
  if (override) return existsSync(override) ? override : null;

  const dirs = [
    process.resourcesPath ? join(process.resourcesPath, "bin", "sortformer") : null,
    join(dirname(process.execPath), "bin", "sortformer"),
    join(process.cwd(), "resources", "bin", "sortformer"),
  ];
  for (const dir of dirs) {
    const path = dir ? join(dir, "parakeet") : "";
    if (path && existsSync(path)) return path;
  }
  return null;
}
