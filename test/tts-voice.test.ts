import { describe, expect, it } from "vitest";
import { TTS_VOICES, validateArchiveEntry, voiceById } from "../src/main/tts/voice";
import { TTS_VOICE_IDS } from "../src/shared/ipc";

const NORMAN = "en_US-norman-medium";

describe("TTS voice archive", () => {
  it("accepts only the pinned root and files", () => {
    for (const voice of TTS_VOICES) {
      const model = `${voice.archiveRoot}/${voice.modelFile}`;
      expect(validateArchiveEntry(voice.id, { name: model, type: "file", size: 10 })).toBe(model);
      const dictionary = `${voice.archiveRoot}/espeak-ng-data/en_dict`;
      expect(validateArchiveEntry(voice.id, { name: dictionary, type: "file", size: 10 })).toBe(dictionary);
    }
  });

  it("registers the pinned voice catalog", () => {
    expect(TTS_VOICES.map((voice) => voice.id)).toEqual(TTS_VOICE_IDS);
    expect(TTS_VOICES.map((voice) => voice.displayName)).toEqual([
      "Norman",
      "LJSpeech",
      "Lessac",
      "Kristin",
      "Amy",
      "Cori",
      "Alan",
    ]);
    expect(() => voiceById("unknown")).toThrow(/unknown TTS voice/);
  });

  it("does not accept one voice's files under another voice id", () => {
    expect(() => validateArchiveEntry("en_US-ljspeech-medium", {
      name: "vits-piper-en_US-norman-medium/en_US-norman-medium.onnx",
      type: "file",
      size: 10,
    })).toThrow(/unexpected TTS archive root/);
  });

  it.each([
    "../outside",
    "/tmp/outside",
    "vits-piper-en_US-norman-medium/../../outside",
    "vits-piper-en_US-norman-medium\\outside",
    "another-root/model.onnx",
    "vits-piper-en_US-norman-medium/unexpected.bin",
  ])("rejects path %s", (name) => {
    expect(() => validateArchiveEntry(NORMAN, { name, type: "file", size: 1 })).toThrow();
  });

  it.each(["symlink", "link", "character-device", "block-device"] as const)(
    "rejects %s entries",
    (type) => {
      expect(() => validateArchiveEntry(NORMAN, {
        name: "vits-piper-en_US-norman-medium/espeak-ng-data/en_dict",
        type,
        size: 1,
      })).toThrow();
    },
  );
});
