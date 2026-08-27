import { describe, expect, it } from "vitest";
import { whisperVariant } from "../src/worker/native-backend";

const enabled = process.env.UNOTTR_NATIVE_SMOKE === "1";

describe.skipIf(!enabled)("host native addons", () => {
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
