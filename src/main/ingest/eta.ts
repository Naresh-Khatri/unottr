// How much longer this job has to run. Transcription and diarization are the two stages
// worth waiting on — everything else is noise next to them — and both cost time roughly
// proportional to the length of the audio, so the whole estimate is one number per stage:
// wall ms per ms of source audio. `db/stage-rates.ts` learns those from finished jobs; the
// priors here are what a machine that has never run one gets to start from.

import type { Resolved, Status } from "../../shared/ipc";

/** The stages that cost real time, in the order a job runs them. */
export const TIMED = ["extracting", "transcribing", "diarizing"] as const;
export type Timed = (typeof TIMED)[number];

export const isTimed = (s: Status): s is Timed => (TIMED as readonly Status[]).includes(s);

/** Wall ms per ms of source audio, one per timed stage. */
export type Rates = Record<Timed, number>;

/** Stage, device and model are the three things the rate depends on; nothing else moves it much. */
export const rateKey = (stage: Timed, device: Resolved, model: string): string =>
  `${stage}:${device}:${model}`;

/**
 * Seeds, from DESIGN.md's measured performance tables (RX 6700 XT vs 12 cpu threads). Wrong
 * on any other machine, but right to within an order of magnitude, which is all a first-ever
 * estimate needs — the learned rate replaces it after one recording.
 */
const PRIOR: Record<string, number> = {
  // ffmpeg decode is ~1000× realtime; the two-track mix path is the slow case, not the norm
  "extracting:*:*": 0.002,
  "transcribing:gpu:large-v3-turbo": 0.041, // 33-min meeting in 82.6 s
  "transcribing:gpu:medium": 0.08,
  "transcribing:gpu:small": 0.023,
  "transcribing:gpu:base.en": 0.009,
  "transcribing:gpu:*": 0.05,
  "transcribing:cpu:large-v3-turbo": 1.3, // slower than realtime, hence the tier default
  "transcribing:cpu:medium": 2.0,
  "transcribing:cpu:small": 0.7,
  "transcribing:cpu:base.en": 0.15,
  "transcribing:cpu:*": 1.0,
  // measured at about 6 s for a 5-minute sample on an RX 6700 XT
  "diarizing:gpu:sortformer-4spk-v2.1-q8": 0.02,
  // sherpa has no gpu path, so this fallback does not vary with the asr device
  "diarizing:*:*": 0.2,
};

/** Prior for a `rateKey`, falling back through the stage's wildcards. */
export function prior(key: string): number {
  const [stage, device] = key.split(":");
  return PRIOR[key] ?? PRIOR[`${stage}:${device}:*`] ?? PRIOR[`${stage}:*:*`] ?? 0.5;
}

/** Fraction of a stage that has to be done before its observed speed is trusted outright. */
const TRUST_AT = 0.2;

export interface EtaOptions {
  /** Source audio length. Without it there is nothing to scale a rate by, so: no estimate. */
  durationMs: number | null;
  rates: Rates;
  now?: () => number;
}

/**
 * Remaining wall time for the rest of the job, refined as it runs.
 *
 * Two estimates blended: the rate scaled by audio length, which exists before a stage has
 * done anything, and what the stage is *actually* managing right now, which is the only one
 * that knows the machine is loaded, throttling, or on a different device than last time. The
 * observed one takes over by `TRUST_AT` into the stage.
 */
export class Eta {
  private stage: Timed | null = null;
  private startedAt = 0;
  private startedPct = 0;

  constructor(private readonly o: EtaOptions) {}

  /** Remaining ms for the whole job, or null when it cannot be said. */
  tick(stage: Status, pct: number): number | null {
    const duration = this.o.durationMs;
    if (!duration || duration <= 0) return null;
    if (!isTimed(stage)) return stage === "probing" ? Math.round(this.ahead(0)) : null;

    const now = (this.o.now ?? Date.now)();
    if (this.stage !== stage) {
      this.stage = stage;
      this.startedAt = now;
      // not always 0: a resumed transcription opens at the checkpoint it starts from
      this.startedPct = clamp01(pct);
    }

    const p = clamp01(pct);
    const predicted = this.o.rates[stage] * duration * (1 - p);
    const done = p - this.startedPct;
    const elapsed = now - this.startedAt;

    let remaining = predicted;
    if (done > 0 && elapsed > 0) {
      const observed = (elapsed / done) * (1 - p);
      const w = Math.min(1, done / TRUST_AT);
      remaining = w * observed + (1 - w) * predicted;
    }
    return Math.round(remaining + this.ahead(TIMED.indexOf(stage) + 1));
  }

  /** Predicted cost of the stages not started yet. */
  private ahead(from: number): number {
    const duration = this.o.durationMs ?? 0;
    return TIMED.slice(from).reduce((ms, s) => ms + this.o.rates[s] * duration, 0);
  }
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
