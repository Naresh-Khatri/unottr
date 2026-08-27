import { describe, expect, it } from "vitest";
import { modelPolicy, supportSpecs } from "../src/main/models/setup";

describe("model setup policy", () => {
  it("defaults Apple Silicon to Turbo with Small as offline recovery", () => {
    expect(modelPolicy("darwin", "arm64")).toEqual({
      recommendedTier: "turbo",
      recoveryTier: "small",
    });
    expect(supportSpecs("darwin", "arm64").map((m) => m.name)).toContain("small");
  });

  it("keeps Linux first-run and support models unchanged", () => {
    expect(modelPolicy("linux", "x64")).toEqual({
      recommendedTier: "small",
      recoveryTier: null,
    });
    expect(supportSpecs("linux", "x64").map((m) => m.name)).toEqual([
      "silero-v5.1.2",
      "pyannote-segmentation-3.0",
      "campplus-zh-en",
    ]);
  });

  it("does not treat an Intel Mac as supported Apple Silicon", () => {
    expect(modelPolicy("darwin", "x64")).toEqual({
      recommendedTier: "small",
      recoveryTier: null,
    });
  });
});
