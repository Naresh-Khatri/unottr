// Apple Silicon exposes useful telemetry through private macOS APIs rather than sysfs.
// Keep this adapter optional: unsupported Macs and a future macOS API change should leave
// the ordinary CPU/RAM meters working, not prevent the app from starting.

export interface AppleHardwareSample {
  soc?: { chipName: string };
  cpu: {
    tempCelsius: number | null;
    powerWatts: number | null;
  };
  gpu: {
    usageRatio: number | null;
    tempCelsius: number | null;
    powerWatts: number | null;
  };
}

interface AppleSampler {
  sample(options?: { intervalMs?: number }): Promise<AppleHardwareSample>;
  close(): void;
}

interface AppleMetricsModule {
  createSampler(options?: { intervalMs?: number }): AppleSampler;
}

const SAMPLE_MS = 500;
const PACKAGE = "apple-silicon-metrics";

let samplerPromise: Promise<AppleSampler | null> | null = null;
let sampler: AppleSampler | null = null;
let pending: Promise<AppleHardwareSample | null> | null = null;
let warned = false;

async function loadSampler(): Promise<AppleSampler | null> {
  if (process.platform !== "darwin" || process.arch !== "arm64") return null;
  samplerPromise ??= import(PACKAGE)
    .then((module) => {
      sampler = (module as AppleMetricsModule).createSampler({ intervalMs: SAMPLE_MS });
      return sampler;
    })
    .catch((error: unknown) => {
      warn(error);
      return null;
    });
  return samplerPromise;
}

/** Concurrent renderer polls share one sample window instead of queueing native reads. */
export async function sampleAppleHardware(): Promise<AppleHardwareSample | null> {
  if (pending) return pending;
  pending = loadSampler()
    .then((loaded) => loaded?.sample({ intervalMs: SAMPLE_MS }) ?? null)
    .catch((error: unknown) => {
      warn(error);
      sampler?.close();
      sampler = null;
      samplerPromise = Promise.resolve(null);
      return null;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

export function closeAppleHardware(): void {
  sampler?.close();
  sampler = null;
  samplerPromise = null;
  pending = null;
}

function warn(error: unknown): void {
  if (warned) return;
  warned = true;
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[system] Apple Silicon sensors unavailable: ${message}`);
}
