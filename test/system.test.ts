import { cpus } from "node:os";
import { describe, expect, it } from "vitest";
import type { AppleHardwareSample } from "../src/main/system/apple";
import { sampleCpu, sampleGpu } from "../src/main/system/stats";

const apple: AppleHardwareSample = {
  soc: { chipName: "Apple M4 Pro" },
  cpu: { tempCelsius: 61.3, powerWatts: 3.16 },
  gpu: { usageRatio: 0.42, tempCelsius: 54.7, powerWatts: 8.26 },
};

describe("cpu sampling", () => {
  it("reports one ratio per logical core", () => {
    const s = sampleCpu();
    expect(s.cores).toHaveLength(cpus().length);
    for (const c of s.cores) expect(c).toBeGreaterThanOrEqual(0);
    for (const c of s.cores) expect(c).toBeLessThanOrEqual(1);
    expect(s.usage).toBeGreaterThanOrEqual(0);
    expect(s.usage).toBeLessThanOrEqual(1);
    expect(s.mem_used).toBeLessThanOrEqual(s.mem_total);
  });

  it("reuses the last answer inside the minimum window", () => {
    expect(sampleCpu()).toBe(sampleCpu());
  });

  // rapl is root-only on some distros and absent off linux, so null is a valid answer
  it("reports package power and temperature, or null — never undefined", async () => {
    await new Promise((r) => setTimeout(r, 300)); // past MIN_WINDOW_MS, so the energy delta is real
    const { watts, temp_c } = sampleCpu();
    expect(watts === null || (watts >= 0 && watts < 1000)).toBe(true);
    expect(temp_c === null || (temp_c > 0 && temp_c < 150)).toBe(true);
  });

  it("uses Apple Silicon temperature and power when available", async () => {
    await new Promise((r) => setTimeout(r, 300));
    const sample = sampleCpu(apple);
    expect(sample.temp_c).toBe(61);
    expect(sample.watts).toBe(3.2);
  });
});

describe("gpu sampling", () => {
  // whatever this machine has (or hasn't) — the contract is the shape, not the numbers
  it("returns null or a fully-formed row", async () => {
    const g = await sampleGpu();
    if (g === null) return;
    expect(typeof g.name).toBe("string");
    for (const v of [g.usage, g.vram_used, g.vram_total, g.temp_c, g.watts]) {
      expect(v === null || Number.isFinite(v)).toBe(true);
    }
    if (g.usage !== null) expect(g.usage).toBeLessThanOrEqual(1);
  });

  it("maps Apple Silicon GPU telemetry without inventing dedicated VRAM", async () => {
    await expect(sampleGpu(apple)).resolves.toEqual({
      name: "Apple M4 Pro GPU",
      usage: 0.42,
      vram_used: null,
      vram_total: null,
      temp_c: 55,
      watts: 8.3,
    });
  });
});
