import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { check, discover, extractPcm } from "../src/main/media/ffmpeg";
import { VAD, findWhisper } from "../src/main/models/catalog";
import { modelPath } from "../src/main/models/download";
import { modelsDir } from "../src/main/paths";
import { detectSpeech } from "../src/worker/vad";
import { Transcriber, defaultOptions } from "../src/worker/whisper";
import { whisperVariant } from "../src/worker/native-backend";

const enabled = process.env.UNOTTR_NATIVE_SMOKE === "1";
const pipelineEnabled = process.env.UNOTTR_NATIVE_PIPELINE_SMOKE === "1";

describe.skipIf(!enabled)("host native addons", () => {
  // Production keeps speech add-ons in workers. Run the main-process FFmpeg check before
  // loading those add-ons into this shared test process, where Windows DLL state can leak.
  it.skipIf(!pipelineEnabled)("runs FFmpeg, VAD, and CPU transcription", async () => {
    const model = findWhisper("base.en");
    expect(model).toBeDefined();

    const cli = discover();
    const usable = check(cli);
    if (!usable) {
      const diagnostics = Object.entries(cli).map(([name, binary]) => {
        const result = spawnSync(binary, ["-version"], { encoding: "utf8" });
        return {
          name,
          binary,
          status: result.status,
          signal: result.signal,
          error: result.error?.message,
          stderr: result.stderr?.trim(),
        };
      });
      expect(usable, `FFmpeg launch failed: ${JSON.stringify(diagnostics)}`).toBe(true);
    }

    const dir = await mkdtemp(join(tmpdir(), "unottr-native-smoke-"));
    const pcmPath = join(dir, "jfk.pcm");
    let transcriber: Transcriber | undefined;
    try {
      await extractPcm(cli, join(modelsDir(), "jfk.wav"), { audioIndex: 0, out: pcmPath });
      const pcm = await readFile(pcmPath);
      const speech = await detectSpeech(pcm, modelPath(VAD));
      expect(speech.length).toBeGreaterThan(0);

      transcriber = await Transcriber.load(modelPath(model!), "cpu", defaultOptions());
      const utterances = await transcriber.run(pcm);
      expect(utterances.map((utterance) => utterance.text).join(" ")).toMatch(
        /ask not what your country can do for you/i,
      );
    } finally {
      await transcriber?.release();
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it("loads the host Whisper package", async () => {
    const variant = whisperVariant();
    console.info(
      `[native smoke] platform=${process.platform} arch=${process.arch} whisper=${variant}`,
    );
    const whisper = await import("@fugood/whisper.node");
    const loaded = await whisper.loadWhisperModule(variant);
    expect(loaded.WhisperContext).toBeTypeOf("function");
    expect(loaded.WhisperVadContext).toBeTypeOf("function");
  });

  it("loads sherpa-onnx", async () => {
    const sherpa = await import("sherpa-onnx-node");
    expect(sherpa.OfflineSpeakerDiarization).toBeTypeOf("function");
    expect(sherpa.SpeakerEmbeddingExtractor).toBeTypeOf("function");
    expect(sherpa.OfflineTts).toBeTypeOf("function");
  });

  it("opens better-sqlite3", async () => {
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(":memory:");
    try {
      expect(db.prepare("select 1 as value").get()).toEqual({ value: 1 });
    } finally {
      db.close();
    }
  });
});
