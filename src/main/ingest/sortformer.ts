import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Turn } from "../../worker/types";
import { err } from "../errors";

const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;
const CHUNK_MS = 2_000;

interface JsonTurn {
  speaker?: unknown;
  start?: unknown;
  end?: unknown;
  chunk?: unknown;
}

export function parseSortformerLine(line: string): { turn: Turn; chunk: number } | null {
  let value: JsonTurn;
  try {
    value = JSON.parse(line) as JsonTurn;
  } catch {
    return null;
  }
  if (
    typeof value.speaker !== "number" ||
    !Number.isInteger(value.speaker) ||
    typeof value.start !== "number" ||
    typeof value.end !== "number" ||
    typeof value.chunk !== "number" ||
    !Number.isInteger(value.chunk) ||
    value.speaker < 0 ||
    value.chunk < 0 ||
    value.start < 0 ||
    value.end <= value.start
  ) {
    return null;
  }
  return {
    turn: {
      speaker: value.speaker as number,
      start_ms: Math.round(value.start * 1000),
      end_ms: Math.round(value.end * 1000),
    },
    chunk: value.chunk as number,
  };
}

export interface SortformerRun {
  runtime: string;
  model: string;
  pcm: string;
  threads: number;
  onProgress?: (pct: number) => void;
  signal?: AbortSignal;
}

/** Run AOSC streaming diarization and refuse a silent CPU fallback from the native runtime. */
export async function runSortformer(o: SortformerRun): Promise<Turn[]> {
  if (o.signal?.aborted) throw err.cancelled();
  const runtime = resolve(o.runtime);
  const model = resolve(o.model);
  const pcm = resolve(o.pcm);
  const audioMs = (statSync(pcm).size / (SAMPLE_RATE * BYTES_PER_SAMPLE)) * 1000;
  const runtimeDir = dirname(runtime);
  const child = spawn(
    runtime,
    [
      "--model", model,
      "--pcm-in", pcm,
      "--pcm-format", "s16le",
      "--pcm-rate", String(SAMPLE_RATE),
      "--n-gpu-layers", "1",
      "--threads", String(Math.max(1, o.threads)),
      "--stream",
      "--stream-chunk-ms", String(CHUNK_MS),
      "--stream-history-ms", "30000",
      "--emit", "jsonl",
      "--verbose",
    ],
    {
      cwd: runtimeDir,
      env: {
        ...process.env,
        LD_LIBRARY_PATH: [runtimeDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(delimiter),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const turns: Turn[] = [];
  let lastProgress = 0;
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-64_000);
  });

  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const parsed = parseSortformerLine(line);
    if (!parsed) return;
    turns.push(parsed.turn);
    const progress = audioMs > 0 ? Math.min(0.99, ((parsed.chunk + 1) * CHUNK_MS) / audioMs) : 0.99;
    if (progress > lastProgress) {
      lastProgress = progress;
      o.onProgress?.(progress);
    }
  });

  const abort = () => child.kill("SIGTERM");
  o.signal?.addEventListener("abort", abort, { once: true });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (value) => resolve(value ?? 1));
  }).finally(() => o.signal?.removeEventListener("abort", abort));

  if (o.signal?.aborted) throw err.cancelled();
  if (code !== 0) {
    const detail = stderr.trim().split("\n").at(-1) ?? `sortformer exited (${code})`;
    throw err.diarize(detail);
  }
  if (!/ggml_vulkan:\s*Found\s+[1-9]\d*\s+Vulkan devices|backend:\s*Vulkan\d+|using Vulkan backend/.test(stderr)) {
    throw err.diarize("Sortformer could not use the Vulkan GPU backend");
  }

  o.onProgress?.(1);
  return turns.sort((a, b) => a.start_ms - b.start_ms || a.speaker - b.speaker);
}
