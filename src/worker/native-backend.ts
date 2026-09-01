export type WhisperVariant = "default" | "vulkan";

/** macOS uses Metal, Linux keeps Vulkan, and the first Windows preview is CPU-only. */
export function whisperVariant(
  platform: NodeJS.Platform = process.platform,
): WhisperVariant {
  return platform === "linux" ? "vulkan" : "default";
}

export const WHISPER_VARIANT = whisperVariant();
