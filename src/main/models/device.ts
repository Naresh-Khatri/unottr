// Port of the device half of crates/unottr-core/src/transcribe/engine.rs.
//
// Deviation from the rust, forced by the addon: whisper-rs exposed `vulkan::list_devices()`
// (name + free/total vram, straight from VK_EXT_memory_budget). @fugood/whisper.node exposes
// no device api at all, and it swallows ggml's native log — `toggleNativeLog` delivered zero
// lines around an `initWhisper({ useGpu: true })` that demonstrably ran, so the "read back
// whether it landed on Vulkan0" plan is not observable from js. What is observable is the
// same loader whisper's vulkan backend will use: ask `vulkaninfo` if it is installed, else
// look for a driver manifest. Both honour VK_DRIVER_FILES, so forcing the cpu path still
// works the way the plan's acceptance check expects.
//
// The vram threshold goes with it — no source for free bytes here. A discrete/integrated
// vulkan device counts; a software rasterizer does not.

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Device, Resolved } from "../../shared/ipc";
import type { ModelSpec } from "./catalog";
import { defaultWhisper } from "./catalog";

export interface GpuInfo {
  /** Index as vulkan reports it — `Vulkan0` in ggml's own logs. */
  id: number;
  name: string;
}

let cache: GpuInfo[] | undefined;

/** Vulkan devices whisper could use. Probed once per session; the answer can't change. */
export function gpus(): GpuInfo[] {
  cache ??= fromVulkaninfo() ?? fromIcdManifests();
  return cache;
}

/** Tests and the settings screen's "re-detect"; nothing else should need it. */
export function resetGpuCache(): void {
  cache = undefined;
}

/**
 * `gpu` is taken at the user's word — if they forced it and there is no card, whisper falls
 * back on its own rather than failing.
 */
export function resolve(device: Device): Resolved {
  switch (device) {
    case "cpu":
      return "cpu";
    case "gpu":
      return "gpu";
    default:
      return gpus().length > 0 ? "gpu" : "cpu";
  }
}

/** The tier `model_tier = "auto"` means on this machine. */
export const defaultModel = (device: Device = "auto"): ModelSpec =>
  defaultWhisper(resolve(device) === "gpu");

// ---------------------------------------------------------------------------- probes

const SOFTWARE = /lvp|lavapipe|swiftshader|softwarerast/i;

function fromVulkaninfo(): GpuInfo[] | undefined {
  const r = spawnSync("vulkaninfo", ["--summary"], { encoding: "utf8", timeout: 10_000 });
  // no binary, or it could not create an instance (that is what a broken driver looks like)
  if (r.error || r.status !== 0 || !r.stdout.includes("Devices:")) return undefined;

  const out: GpuInfo[] = [];
  let id = -1;
  let name = "";
  let type = "";
  const flush = () => {
    if (id >= 0 && name && !type.endsWith("_CPU")) out.push({ id, name });
  };
  for (const line of r.stdout.split("\n")) {
    const gpu = /^GPU(\d+):/.exec(line.trim());
    if (gpu) {
      flush();
      id = Number(gpu[1]);
      name = "";
      type = "";
      continue;
    }
    const [key, value] = split(line);
    if (key === "deviceName") name = value;
    if (key === "deviceType") type = value;
  }
  flush();
  return out;
}

function split(line: string): [string, string] {
  const eq = line.indexOf("=");
  if (eq < 0) return ["", ""];
  return [line.slice(0, eq).trim(), line.slice(eq + 1).trim()];
}

/**
 * Fallback when vulkaninfo is not installed: the loader's own search path. Less precise —
 * a manifest means a driver is registered, not that it enumerates a device — but it is the
 * same set of files the loader reads, including the VK_DRIVER_FILES override.
 */
function fromIcdManifests(): GpuInfo[] {
  const out: GpuInfo[] = [];
  for (const file of manifests()) {
    let lib: string;
    try {
      const json = JSON.parse(readFileSync(file, "utf8")) as { ICD?: { library_path?: string } };
      lib = json.ICD?.library_path ?? "";
    } catch {
      continue;
    }
    if (!lib || SOFTWARE.test(lib)) continue;
    out.push({ id: out.length, name: lib.replace(/^.*\//, "") });
  }
  return out;
}

function manifests(): string[] {
  const override = process.env.VK_DRIVER_FILES || process.env.VK_ICD_FILENAMES;
  const entries = override ? override.split(":").filter(Boolean) : defaultIcdDirs();
  const out: string[] = [];
  for (const entry of entries) {
    let dir = false;
    try {
      dir = statSync(entry).isDirectory();
    } catch {
      continue; // a listed path that does not exist = no driver, which is the point
    }
    if (!dir) {
      out.push(entry);
      continue;
    }
    try {
      for (const f of readdirSync(entry)) if (f.endsWith(".json")) out.push(join(entry, f));
    } catch {
      // unreadable directory, same as empty
    }
  }
  return out;
}

const defaultIcdDirs = (): string[] => {
  const home = process.env.XDG_DATA_HOME || join(homedir(), ".local/share");
  return [
    join(home, "vulkan/icd.d"),
    "/etc/vulkan/icd.d",
    "/usr/local/etc/vulkan/icd.d",
    "/usr/local/share/vulkan/icd.d",
    "/usr/share/vulkan/icd.d",
  ];
};
