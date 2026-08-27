import { describe, expect, it } from "vitest";
import { isOomMessage } from "../src/worker/whisper-errors";

describe("Whisper GPU memory errors", () => {
  it.each([
    "VK_ERROR_OUT_OF_DEVICE_MEMORY",
    "failed to allocate Metal buffer",
    "Metal buffer allocation failed",
    "Insufficient memory for command buffer",
    "kIOGPUCommandBufferCallbackErrorOutOfMemory",
  ])("classifies %s as an OOM", (message) => {
    expect(isOomMessage(message)).toBe(true);
  });

  it.each([
    "compute worker exited (1)",
    "invalid model magic",
    "allocation failed while parsing metadata",
    "there is room for the model",
  ])("leaves %s as a generic failure", (message) => {
    expect(isOomMessage(message)).toBe(false);
  });
});
