import { isAppleSilicon } from "../platform";
import {
  SEGMENTATION,
  VAD,
  defaultEmbedding,
  findWhisper,
  type ModelSpec,
} from "./catalog";

export type SetupTier = "turbo" | "medium" | "small";

export interface ModelPolicy {
  recommendedTier: SetupTier;
  recoveryTier: SetupTier | null;
}

export function modelPolicy(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ModelPolicy {
  return isAppleSilicon(platform, arch)
    ? { recommendedTier: "turbo", recoveryTier: "small" }
    : { recommendedTier: "small", recoveryTier: null };
}

export function supportSpecs(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ModelSpec[] {
  const specs = [VAD, SEGMENTATION, defaultEmbedding()];
  if (!isAppleSilicon(platform, arch)) return specs;

  const small = findWhisper("small");
  if (!small) throw new Error("model catalog does not contain the Small recovery model");
  return [...specs, small];
}
