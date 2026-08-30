import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";

import sherpa from "sherpa-onnx-node";

const SHORT_TEXT =
  "The meeting starts at ten tomorrow morning. I found three decisions and two action items in your notes.";
const LONG_TEXT =
  "Here is the short version. The team agreed to finish the prototype this week, review it on Monday, and record any open questions before the next meeting.";
const CANCEL_TEXT = Array.from(
  { length: 8 },
  () =>
    "This deliberately long sentence checks whether the native text to speech callback can stop synthesis without crashing the process.",
).join(" ");

function usage(message) {
  if (message) console.error(message);
  console.error(
    "Usage: node scripts/benchmark-tts.mjs --model-dir DIR --voice-id ID --output-dir DIR [--threads N] [--runs N] [--json FILE]",
  );
  process.exit(2);
}

function readArgs(argv) {
  if (argv[0] === "--") argv = argv.slice(1);
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || value == null) usage(`Invalid argument: ${key ?? ""}`);
    values[key.slice(2)] = value;
  }

  const threads = Number(values.threads ?? "2");
  const runs = Number(values.runs ?? "5");
  if (!values["model-dir"] || !values["voice-id"] || !values["output-dir"]) usage();
  if (!Number.isInteger(threads) || threads < 1 || threads > 16) usage("--threads must be 1 to 16");
  if (!Number.isInteger(runs) || runs < 1 || runs > 20) usage("--runs must be 1 to 20");

  return {
    modelDir: path.resolve(values["model-dir"]),
    voiceId: values["voice-id"],
    outputDir: path.resolve(values["output-dir"]),
    jsonPath: values.json ? path.resolve(values.json) : null,
    threads,
    runs,
  };
}

function round(value, digits = 3) {
  return Number(value.toFixed(digits));
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function mib(bytes) {
  return round(bytes / 1024 / 1024, 1);
}

async function modelPaths(modelDir) {
  const entries = await readdir(modelDir);
  const models = entries.filter((entry) => entry.endsWith(".onnx"));
  if (models.length !== 1) throw new Error(`Expected one .onnx file in ${modelDir}, found ${models.length}`);

  const result = {
    model: path.join(modelDir, models[0]),
    tokens: path.join(modelDir, "tokens.txt"),
    dataDir: path.join(modelDir, "espeak-ng-data"),
  };
  await Promise.all(Object.values(result).map((entry) => access(entry)));
  return result;
}

async function synthesize(tts, generationConfig, text, onProgress) {
  const startedAt = performance.now();
  let firstChunkMs = null;
  let chunks = 0;
  const audio = await tts.generateAsync({
    text,
    generationConfig,
    onProgress: onProgress
      ? (info) => {
          chunks += 1;
          firstChunkMs ??= performance.now() - startedAt;
          return onProgress(info);
        }
      : undefined,
  });
  const synthesisMs = performance.now() - startedAt;
  const durationMs = (audio.samples.length / audio.sampleRate) * 1000;
  return {
    audio,
    metrics: {
      synthesisMs: round(synthesisMs, 1),
      durationMs: round(durationMs, 1),
      rtf: round(synthesisMs / durationMs),
      firstChunkMs: firstChunkMs == null ? null : round(firstChunkMs, 1),
      chunks,
      samples: audio.samples.length,
      sampleRate: audio.sampleRate,
      rssMiB: mib(process.memoryUsage().rss),
    },
  };
}

async function main() {
  const options = readArgs(process.argv.slice(2));
  const paths = await modelPaths(options.modelDir);
  await mkdir(options.outputDir, { recursive: true });

  const rssBeforeLoad = process.memoryUsage().rss;
  const loadStartedAt = performance.now();
  const tts = await sherpa.OfflineTts.createAsync({
    model: {
      vits: paths,
      numThreads: options.threads,
      debug: false,
      provider: "cpu",
    },
    maxNumSentences: 1,
  });
  const loadMs = performance.now() - loadStartedAt;
  const rssAfterLoad = process.memoryUsage().rss;
  const generationConfig = new sherpa.GenerationConfig({
    sid: 0,
    speed: 1,
    silenceScale: 0.2,
  });

  const first = await synthesize(tts, generationConfig, SHORT_TEXT);
  const previewPath = path.join(options.outputDir, `${options.voiceId}.wav`);
  sherpa.writeWave(previewPath, {
    samples: first.audio.samples,
    sampleRate: first.audio.sampleRate,
  });

  const warm = [];
  for (let i = 0; i < options.runs; i += 1) {
    const result = await synthesize(tts, generationConfig, SHORT_TEXT);
    warm.push(result.metrics);
  }

  const long = await synthesize(tts, generationConfig, LONG_TEXT, () => true);

  let cancellation;
  const cancelStartedAt = performance.now();
  try {
    const cancelled = await synthesize(tts, generationConfig, CANCEL_TEXT, () => false);
    cancellation = {
      outcome: "resolved",
      elapsedMs: round(performance.now() - cancelStartedAt, 1),
      ...cancelled.metrics,
    };
  } catch (error) {
    cancellation = {
      outcome: "rejected",
      elapsedMs: round(performance.now() - cancelStartedAt, 1),
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const report = {
    recordedAt: new Date().toISOString(),
    voiceId: options.voiceId,
    modelDir: options.modelDir,
    runtime: {
      sherpaVersion: sherpa.version,
      sherpaGitSha1: sherpa.gitSha1,
      sherpaGitDate: sherpa.gitDate,
      onnxruntimeVersion: sherpa.onnxruntimeVersion,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model ?? "unknown",
      logicalCpus: os.cpus().length,
      threads: options.threads,
    },
    load: {
      milliseconds: round(loadMs, 1),
      rssBeforeMiB: mib(rssBeforeLoad),
      rssAfterMiB: mib(rssAfterLoad),
      rssDeltaMiB: mib(rssAfterLoad - rssBeforeLoad),
    },
    firstResponse: first.metrics,
    warm: {
      runs: warm,
      medianSynthesisMs: round(median(warm.map((run) => run.synthesisMs)), 1),
      medianRtf: round(median(warm.map((run) => run.rtf))),
    },
    streamingProbe: long.metrics,
    cancellation,
    rssAfterRunsMiB: mib(process.memoryUsage().rss),
    previewPath,
  };

  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.jsonPath) await writeFile(options.jsonPath, json);
  process.stdout.write(json);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
