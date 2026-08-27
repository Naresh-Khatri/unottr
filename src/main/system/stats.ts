// Live cpu/gpu numbers for the sidebar meters. Linux uses sysfs or nvidia-smi. Apple Silicon
// uses a shared native sample because its useful CPU/GPU sensors are not public file reads.

import { execFile, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CpuStats, GpuStats } from "../../shared/ipc";
import { gpus } from "../models/device";
import { sampleAppleHardware, type AppleHardwareSample } from "./apple";

const run = promisify(execFile);

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

// ------------------------------------------------------------------------------- cpu

interface Times {
  idle: number;
  total: number;
}

const snapshot = (): Times[] =>
  cpus().map(({ times }) => ({
    idle: times.idle,
    total: times.user + times.nice + times.sys + times.idle + times.irq,
  }));

/** Below this the delta window is too short to mean anything, so the last answer is reused. */
const MIN_WINDOW_MS = 250;

/**
 * RAPL package domains, one per socket. Still called intel-rapl on amd — the same driver
 * backs Zen's msr. Distros that took the platypus/CVE-2020-8694 fix make energy_uj
 * root-only, so an unreadable domain is expected and just means no wattage.
 */
let raplDomains: string[] | undefined;

function raplPaths(): string[] {
  const found: string[] = [];
  try {
    for (const entry of readdirSync("/sys/class/powercap")) {
      const dir = join("/sys/class/powercap", entry);
      if (!readText(join(dir, "name"))?.startsWith("package")) continue;
      const energy = join(dir, "energy_uj");
      if (readNum(energy) !== null) found.push(energy);
    }
  } catch {
    // no powercap sysfs — not linux, or a kernel built without rapl
  }
  return found;
}

/** Total µJ burned since boot across every package, or null when rapl is unavailable. */
function raplEnergy(): number | null {
  raplDomains ??= raplPaths();
  if (raplDomains.length === 0) return null;
  let total = 0;
  for (const path of raplDomains) {
    const uj = readNum(path);
    if (uj === null) return null;
    total += uj;
  }
  return total;
}

/** µJ/ms is mW. A negative delta = the counter wrapped; that one sample is dropped. */
function watts(before: number | null, after: number | null, ms: number): number | null {
  if (before === null || after === null || ms <= 0) return null;
  const delta = after - before;
  return delta < 0 ? null : Math.round(delta / ms / 1000);
}

// ------------------------------------------------------------------------- cpu temp

/**
 * Which hwmon device and which of its sensors is "the cpu", best first. k10temp/coretemp are
 * the real die sensors; the nct super-i/o chip is the fallback for boxes where those modules
 * never loaded — its TSI0_TEMP is the same die reading taken over SB-TSI, while its own
 * temp1 is a chassis probe, so unlabelled sensors are only trusted on the die drivers.
 */
const CPU_TEMP_SOURCES: { driver: RegExp; labels: string[]; anyTemp: boolean }[] = [
  { driver: /^(k10temp|zenpower)$/, labels: ["Tdie", "Tctl"], anyTemp: true },
  { driver: /^coretemp$/, labels: ["Package id 0"], anyTemp: true },
  { driver: /^nct\d+/, labels: ["TSI0_TEMP", "CPUTIN"], anyTemp: false },
];

let cpuTempPath: string | null | undefined;

function findCpuTemp(): string | null {
  try {
    const devices = readdirSync("/sys/class/hwmon").map((e) => ({
      dir: join("/sys/class/hwmon", e),
      name: readText(join("/sys/class/hwmon", e, "name")) ?? "",
    }));

    for (const source of CPU_TEMP_SOURCES) {
      for (const { dir, name } of devices) {
        if (!source.driver.test(name)) continue;
        const labels = readdirSync(dir).filter((f) => /^temp\d+_label$/.test(f));
        for (const want of source.labels) {
          const hit = labels.find((f) => readText(join(dir, f)) === want);
          if (hit) return join(dir, hit.replace("_label", "_input"));
        }
        if (source.anyTemp && existsSync(join(dir, "temp1_input"))) return join(dir, "temp1_input");
      }
    }
  } catch {
    // no hwmon (not linux), or a node vanished mid-scan
  }
  return null;
}

/** Millidegrees, and a sanity band — an unpopulated super-i/o channel reads 0 or -62°C. */
function cpuTemp(): number | null {
  if (cpuTempPath === undefined) cpuTempPath = findCpuTemp(); // null caches too: scan once
  const milli = readNum(cpuTempPath);
  if (milli === null) return null;
  const c = Math.round(milli / 1000);
  return c > 0 && c < 150 ? c : null;
}

// primed at import so the first poll diffs against app start rather than reporting a flat 0%
let previous = snapshot();
let previousEnergy = raplEnergy();
let sampledAt = Date.now();
let cached: CpuStats | null = null;

export function sampleCpu(apple: AppleHardwareSample | null = null): CpuStats {
  const at = Date.now();
  if (cached && at - sampledAt < MIN_WINDOW_MS) return cached;

  const current = snapshot();
  const cores = current.map((c, i) => {
    const p = previous[i];
    const dt = p ? c.total - p.total : 0;
    return dt > 0 ? clamp01((dt - (c.idle - p.idle)) / dt) : 0;
  });
  const energy = raplEnergy();
  const power = watts(previousEnergy, energy, at - sampledAt);
  previous = current;
  previousEnergy = energy;
  sampledAt = at;

  cached = {
    usage: cores.length > 0 ? cores.reduce((a, b) => a + b, 0) / cores.length : 0,
    cores,
    load1: loadavg()[0] ?? 0,
    mem_used: totalmem() - freemem(),
    mem_total: totalmem(),
    temp_c: validTemperature(apple?.cpu.tempCelsius) ?? cpuTemp(),
    watts: nonNegative(apple?.cpu.powerWatts) ?? power,
  };
  return cached;
}

// ------------------------------------------------------------------------------- gpu

type Source = { kind: "amd"; dir: string } | { kind: "nvidia" } | { kind: "none" };

let source: Source | undefined;

export async function sampleGpu(apple: AppleHardwareSample | null = null): Promise<GpuStats | null> {
  if (apple) return appleGpu(apple);
  source ??= detect();
  // vulkan's name is the better one to show: it is the device whisper actually binds to
  const vulkan = gpus()[0]?.name;

  if (source.kind === "amd") return amdSample(source.dir, vulkan);
  if (source.kind === "nvidia") {
    const sample = await nvidiaSample();
    if (sample) return sample;
  }
  // a card with no readable counter still gets a row — name only, no bar
  return vulkan
    ? { name: vulkan, usage: null, vram_used: null, vram_total: null, temp_c: null, watts: null }
    : null;
}

export async function sampleHardware(): Promise<{ cpu: CpuStats; gpu: GpuStats | null }> {
  const apple = await sampleAppleHardware();
  return { cpu: sampleCpu(apple), gpu: await sampleGpu(apple) };
}

function appleGpu(sample: AppleHardwareSample): GpuStats {
  return {
    name: sample.soc?.chipName ? `${sample.soc.chipName} GPU` : "Apple GPU",
    usage: ratio(sample.gpu.usageRatio),
    // Apple Silicon has unified memory, so presenting RAM as dedicated VRAM would mislead.
    vram_used: null,
    vram_total: null,
    temp_c: validTemperature(sample.gpu.tempCelsius),
    watts: nonNegative(sample.gpu.powerWatts),
  };
}

const ratio = (value: number | null | undefined): number | null =>
  value != null && Number.isFinite(value) ? clamp01(value) : null;

const validTemperature = (value: number | null | undefined): number | null =>
  value != null && Number.isFinite(value) && value > 0 && value < 150 ? Math.round(value) : null;

const nonNegative = (value: number | null | undefined): number | null =>
  value != null && Number.isFinite(value) && value >= 0 ? Math.round(value * 10) / 10 : null;

/** Tests and anything that changes the machine's driver situation mid-session. */
export function resetGpuSource(): void {
  source = undefined;
}

function detect(): Source {
  const dir = amdCard();
  if (dir) return { kind: "amd", dir };
  const r = spawnSync("nvidia-smi", ["-L"], { stdio: "ignore", timeout: 10_000 });
  return !r.error && r.status === 0 ? { kind: "nvidia" } : { kind: "none" };
}

/** `/sys/class/drm/cardN/device` for the first card exposing amdgpu's busy counter. */
function amdCard(): string | null {
  try {
    for (const entry of readdirSync("/sys/class/drm")) {
      if (!/^card\d+$/.test(entry)) continue;
      const dir = join("/sys/class/drm", entry, "device");
      if (existsSync(join(dir, "gpu_busy_percent"))) return dir;
    }
  } catch {
    // no sysfs — not linux, or a sandbox without /sys
  }
  return null;
}

function amdSample(dir: string, vulkanName: string | undefined): GpuStats {
  const busy = readNum(join(dir, "gpu_busy_percent"));
  const temp = readNum(hwmon(dir, "temp1_input")); // millidegrees
  const power = readNum(hwmon(dir, "power1_average")); // microwatts
  return {
    name: vulkanName ?? readText(join(dir, "product_name")) ?? "GPU",
    usage: busy === null ? null : clamp01(busy / 100),
    vram_used: readNum(join(dir, "mem_info_vram_used")),
    vram_total: readNum(join(dir, "mem_info_vram_total")),
    temp_c: temp === null ? null : Math.round(temp / 1000),
    watts: power === null ? null : Math.round(power / 1_000_000),
  };
}

/** hwmonN is numbered per boot, so the leaf has to be found rather than assumed. */
function hwmon(dir: string, file: string): string | null {
  try {
    for (const entry of readdirSync(join(dir, "hwmon"))) {
      const path = join(dir, "hwmon", entry, file);
      if (existsSync(path)) return path;
    }
  } catch {
    // no hwmon node = no temperature or power reading, which is not an error
  }
  return null;
}

const NVIDIA_INTERVAL_MS = 1000;
const NVIDIA_QUERY =
  "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw";

let nvidia: GpuStats | null = null;
let nvidiaAt = 0;
let nvidiaPending: Promise<void> | null = null;

/** One spawn per interval at most; concurrent callers share the reading in flight. */
async function nvidiaSample(): Promise<GpuStats | null> {
  if (!nvidiaPending && Date.now() - nvidiaAt >= NVIDIA_INTERVAL_MS) {
    nvidiaPending = run("nvidia-smi", [NVIDIA_QUERY, "--format=csv,noheader,nounits"], {
      timeout: 4000,
    })
      .then(({ stdout }) => {
        nvidia = parseNvidia(stdout);
      })
      .catch(() => {
        nvidia = null; // driver went away mid-session; fall back to the name-only row
      })
      .finally(() => {
        nvidiaAt = Date.now();
        nvidiaPending = null;
      });
  }
  await nvidiaPending;
  return nvidia;
}

function parseNvidia(stdout: string): GpuStats | null {
  const line = stdout.split("\n").find((l) => l.trim().length > 0);
  if (!line) return null;
  const [name, usage, used, total, temp, watts] = line.split(",").map((f) => f.trim());
  const mib = (v: string): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n * 1024 * 1024 : null;
  };
  return {
    name: name || "GPU",
    usage: Number.isFinite(Number(usage)) ? clamp01(Number(usage) / 100) : null,
    vram_used: mib(used),
    vram_total: mib(total),
    temp_c: Number.isFinite(Number(temp)) ? Math.round(Number(temp)) : null,
    watts: Number.isFinite(Number(watts)) ? Math.round(Number(watts)) : null,
  };
}

function readText(path: string | null): string | null {
  if (!path) return null;
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function readNum(path: string | null): number | null {
  const raw = readText(path);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
