import { describe, expect, it } from "vitest";
import { whisperVariant } from "../src/worker/native-backend";

describe("native Whisper backend", () => {
  it("uses the Metal-capable default package on Darwin", () => {
    expect(whisperVariant("darwin")).toBe("default");
  });

  it("keeps the Vulkan package on Linux", () => {
    expect(whisperVariant("linux")).toBe("vulkan");
  });

  it("uses the CPU package on Windows", () => {
    expect(whisperVariant("win32")).toBe("default");
  });
});
