// Port of crates/unottr-core/src/media/ffmpeg.rs. Strictly read-only on source files:
// ffmpeg only ever writes the pcm we name.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, renameSync, statSync, unlinkSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { err, isCancelled } from "../errors";
import type { AudioStream, Probe } from "./types";
import { TARGET_SAMPLE_RATE } from "./types";

export interface FfmpegCli {
  ffmpeg: string;
  ffprobe: string;
}

export function executableName(
  name: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32" && !name.toLowerCase().endsWith(".exe") ? `${name}.exe` : name;
}

/** platform resource -> legacy resource -> PATH */
export function bundledCandidates(
  name: string,
  host: {
    platform?: NodeJS.Platform;
    arch?: string;
    resourcesPath?: string;
    execPath?: string;
    cwd?: string;
  } = {},
): string[] {
  const platform = host.platform ?? process.platform;
  const platformDir = `${platform}-${host.arch ?? process.arch}`;
  const file = executableName(name, platform);
  const resourcesPath = host.resourcesPath ?? process.resourcesPath;
  const bases = [
    resourcesPath ? join(resourcesPath, "bin") : null,
    join(dirname(host.execPath ?? process.execPath), "bin"),
    join(host.cwd ?? process.cwd(), "resources", "bin"),
  ].filter((dir): dir is string => dir !== null);
  return bases.flatMap((dir) => [join(dir, platformDir, file), join(dir, file)]);
}

function bundledOr(name: string): string {
  for (const candidate of bundledCandidates(name)) {
    if (existsSync(candidate)) return candidate;
  }
  return name;
}

export function discover(): FfmpegCli {
  return {
    ffmpeg: process.env.UNOTTR_FFMPEG || bundledOr("ffmpeg"),
    ffprobe: process.env.UNOTTR_FFPROBE || bundledOr("ffprobe"),
  };
}

/** Both settings must be set to override discovery — overriding neither is the common case. */
export function fromSettings(ffmpegPath?: string | null, ffprobePath?: string | null): FfmpegCli {
  return ffmpegPath && ffprobePath ? { ffmpeg: ffmpegPath, ffprobe: ffprobePath } : discover();
}

/** Both binaries resolve and run. Shown in settings so the user sees this before a job fails. */
export function check(cli: FfmpegCli = discover()): boolean {
  return [cli.ffmpeg, cli.ffprobe].every((bin) => {
    const r = spawnSync(bin, ["-version"], { stdio: "ignore" });
    return !r.error && r.status === 0;
  });
}

export async function probe(cli: FfmpegCli, path: string): Promise<Probe> {
  // ffprobe answers "invalid data" for a missing file too; stat first so the user gets the
  // real reason
  try {
    statSync(path);
  } catch (e) {
    throw err.io(path, e);
  }

  const out = await run(cli.ffprobe, [
    "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path,
  ]);

  if (out.code !== 0) {
    // mp4 writes its index last, so an interrupted recording has no moov atom. this is the
    // ordinary "obs died mid-meeting" case, not a corrupt file.
    if (out.stderr.includes("moov atom not found")) throw err.truncated(path);
    const line = out.stderr.split("\n").find((l) => l.trim() !== "");
    throw err.probe(path, (line ?? "ffprobe failed").trim());
  }

  let raw: RawProbe;
  try {
    raw = JSON.parse(out.stdout) as RawProbe;
  } catch (e) {
    throw err.probe(path, `unreadable ffprobe output: ${e instanceof Error ? e.message : e}`);
  }

  const audio: AudioStream[] = [];
  let hasVideo = false;
  for (const s of raw.streams ?? []) {
    // attached cover art is a video stream by ffprobe's reckoning; ignore it
    if (s.codec_type === "video" && (s.disposition?.attached_pic ?? 0) === 0) hasVideo = true;
    if (s.codec_type !== "audio") continue;
    audio.push({
      index: s.index,
      audio_index: audio.length,
      codec: s.codec_name ?? "?",
      channels: s.channels ?? 0,
      sample_rate: int(s.sample_rate) ?? 0,
      title: s.tags?.title ?? null,
      language: s.tags?.language ?? null,
    });
  }
  if (audio.length === 0) throw err.noAudio(path);

  // a still-recording or interrupted file reports no duration; treating that as truncated is
  // what lets the watcher wait instead of transcribing a partial file
  const seconds = Number(raw.format?.duration);
  if (!Number.isFinite(seconds) || seconds <= 0) throw err.truncated(path);

  return {
    container: raw.format?.format_name ?? "?",
    duration_ms: Math.round(seconds * 1000),
    has_video: hasVideo,
    audio,
  };
}

export interface ExtractOptions {
  /** Position among audio streams, not the global stream index — this is `-map 0:a:N`. */
  audioIndex: number;
  out: string;
  onProgress?: (pct: number) => void;
  signal?: AbortSignal;
}

/** Decodes one audio track to 16 kHz mono s16le. */
export async function extractPcm(cli: FfmpegCli, path: string, o: ExtractOptions): Promise<void> {
  throwIfAborted(o.signal);
  const totalMs = (await probe(cli, path)).duration_ms ?? 0;
  await mkdir(dirname(o.out), { recursive: true });

  const args = [
    "-nostdin", "-v", "error", "-progress", "pipe:1", "-y", "-i", path,
    "-map", `0:a:${o.audioIndex}`, "-vn", "-sn", "-dn",
    "-ac", "1", "-ar", String(TARGET_SAMPLE_RATE), "-acodec", "pcm_s16le", "-f", "s16le",
    o.out,
  ];

  const result = await run(cli.ffmpeg, args, {
    signal: o.signal,
    onStdoutLine: (line) => {
      const doneMs = progressMs(line);
      if (doneMs !== null && totalMs > 0) {
        o.onProgress?.(Math.min(1, Math.max(0, doneMs / totalMs)));
      }
    },
  });

  if (result.aborted) {
    discard(o.out);
    throw err.cancelled();
  }
  if (result.code !== 0) {
    discard(o.out);
    const lines = result.stderr.trim().split("\n").filter((l) => l !== "");
    throw err.ffmpeg(`${path}: ${lines.at(-1) ?? "no output"}`);
  }

  o.onProgress?.(1);
}

export interface ThumbnailOptions {
  durationMs: number;
  thumb: string;
  previews: string[];
  signal?: AbortSignal;
  onProgress?: (pct: number) => void;
}

/**
 * One cover frame (10% in — frame 0 is often black) plus `previews`, evenly spaced across the
 * rest of the recording. Idempotent per file, like extractPcm. A single frame that fails to
 * grab (e.g. a seek past a variable-framerate gap) is logged and skipped rather than failing
 * the whole job — thumbnails are not on the critical path the way transcription is.
 */
export async function extractThumbnails(
  cli: FfmpegCli,
  path: string,
  o: ThumbnailOptions,
): Promise<void> {
  throwIfAborted(o.signal);
  await mkdir(dirname(o.thumb), { recursive: true });

  const seconds = (f: number): number => (o.durationMs / 1000) * f;
  const targets: { out: string; at: number; width: number }[] = [
    { out: o.thumb, at: seconds(0.1), width: 320 },
    ...o.previews.map((out, i) => ({
      out,
      at: seconds((i + 1) / (o.previews.length + 1)),
      width: 160,
    })),
  ];

  let completed = 0;
  o.onProgress?.(0);
  for (const t of targets) {
    if (existsSync(t.out)) {
      completed += 1;
      o.onProgress?.(completed / targets.length);
      continue;
    }
    throwIfAborted(o.signal);
    try {
      await grabFrame(cli, path, t.at, t.width, t.out, o.signal);
    } catch (e) {
      if (isCancelled(e)) throw e;
      console.warn(`thumbnail frame failed for ${path} at ${t.at}s: ${String(e)}`);
    }
    completed += 1;
    o.onProgress?.(completed / targets.length);
  }
}

export async function grabFrame(
  cli: FfmpegCli,
  path: string,
  seconds: number,
  width: number,
  out: string,
  signal?: AbortSignal,
): Promise<void> {
  const tmp = `${out}.tmp`;
  const args = [
    "-nostdin", "-v", "error", "-y",
    "-ss", seconds.toFixed(3), "-i", path,
    "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "4",
    // tmp name has no usable extension -> ffmpeg can't infer the muxer
    "-f", "image2", tmp,
  ];

  const result = await run(cli.ffmpeg, args, { signal });
  if (result.aborted) {
    discard(tmp);
    throw err.cancelled();
  }
  if (result.code !== 0) {
    discard(tmp);
    const lines = result.stderr.trim().split("\n").filter((l) => l !== "");
    throw err.ffmpeg(`${path}: ${lines.at(-1) ?? "no output"}`);
  }
  renameSync(tmp, out);
}

/**
 * ffmpeg's `-progress` stream is `key=value` lines; `out_time_us` is authoritative,
 * `out_time_ms` is a misnomer that also holds microseconds on older builds.
 */
export function progressMs(line: string): number | null {
  const eq = line.indexOf("=");
  if (eq < 0) return null;
  const key = line.slice(0, eq);
  if (key !== "out_time_us" && key !== "out_time_ms") return null;
  const value = line.slice(eq + 1).trim();
  // matches rust's u64 parse: "N/A" and ffmpeg's negative i64 sentinel are both rejected
  return /^\d+$/.test(value) ? Math.floor(Number(value) / 1000) : null;
}

/** A partial pcm is worse than none: the pipeline treats an existing file as a finished one. */
function discard(out: string): void {
  try {
    unlinkSync(out);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`could not remove partial pcm ${out}: ${String(e)}`);
    }
  }
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  aborted: boolean;
}

/**
 * Both pipes are consumed as they arrive — a full stderr pipe blocks ffmpeg forever, which
 * is the deadlock the rust drains on a second thread to avoid.
 */
function run(
  bin: string,
  args: string[],
  o: { signal?: AbortSignal; onStdoutLine?: (line: string) => void } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let pending = "";
    let aborted = false;

    const onAbort = (): void => {
      aborted = true;
      child.kill();
    };
    if (o.signal) {
      if (o.signal.aborted) onAbort();
      else o.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      stdout += d;
      if (!o.onStdoutLine) return;
      pending += d;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) o.onStdoutLine(line);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => {
      stderr += d;
    });

    child.on("error", (e: NodeJS.ErrnoException) => {
      o.signal?.removeEventListener("abort", onAbort);
      reject(e.code === "ENOENT" ? err.ffmpegMissing() : err.io(bin, e));
    });
    child.on("close", (code) => {
      o.signal?.removeEventListener("abort", onAbort);
      resolve({ code: code ?? -1, stdout, stderr, aborted });
    });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw err.cancelled();
}

const int = (v: string | undefined): number | null => {
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

interface RawProbe {
  streams?: RawStream[];
  format?: { format_name?: string; duration?: string };
}

interface RawStream {
  index: number;
  codec_type: string;
  codec_name?: string;
  channels?: number;
  sample_rate?: string;
  tags?: Record<string, string>;
  disposition?: { attached_pic?: number };
}
