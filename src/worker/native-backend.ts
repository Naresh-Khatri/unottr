export type WhisperVariant = "default" | "vulkan";

/** Darwin default = Metal; Linux keeps the release's Vulkan package */
export function whisperVariant(
  platform: NodeJS.Platform = process.platform,
): WhisperVariant {
  return platform === "darwin" ? "default" : "vulkan";
}

export const WHISPER_VARIANT = whisperVariant();
