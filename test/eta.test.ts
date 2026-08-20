// The estimator and the rate it runs on. Numbers here are wall ms per ms of source audio, so
// a 10-minute recording at rate 0.1 costs a minute.

import { beforeEach, describe, expect, it } from "vitest";
import { type Db, openDatabase } from "../src/main/db/client";
import { runMigrations } from "../src/main/db/migrate";
import * as rates from "../src/main/db/stage-rates";
import { etaLabel } from "../src/shared/eta";
import { Eta, type Rates, prior, rateKey } from "../src/main/ingest/eta";

const MIN = 60_000;
const FLAT: Rates = { extracting: 0.01, transcribing: 0.1, diarizing: 0.05 };

/** 10 minutes of audio: 6 s extract + 60 s transcribe + 30 s diarize by the rates above. */
const etaOf = (clock: { t: number }, o: Partial<Rates> = {}) =>
  new Eta({ durationMs: 10 * MIN, rates: { ...FLAT, ...o }, now: () => clock.t });

describe("prior", () => {
  it("falls back through the wildcards", () => {
    expect(prior(rateKey("transcribing", "gpu", "large-v3-turbo"))).toBe(0.041);
    expect(prior(rateKey("transcribing", "gpu", "some-future-model"))).toBe(0.05);
    expect(prior(rateKey("diarizing", "cpu", "3dspeaker"))).toBe(0.2);
  });

  it("puts cpu transcription orders of magnitude above gpu", () => {
    expect(prior(rateKey("transcribing", "cpu", "large-v3-turbo"))).toBeGreaterThan(
      prior(rateKey("transcribing", "gpu", "large-v3-turbo")) * 10,
    );
  });
});

describe("Eta", () => {
  it("quotes the whole run before any of it has happened", () => {
    const clock = { t: 0 };
    expect(etaOf(clock).tick("probing", 1)).toBe(96_000);
  });

  it("counts the stages still ahead, not just the one running", () => {
    const clock = { t: 0 };
    // half way through transcription: 30 s of it left, plus all 30 s of diarization
    expect(etaOf(clock).tick("transcribing", 0.5)).toBe(60_000);
  });

  it("drops to zero as the last stage closes out", () => {
    const clock = { t: 0 };
    expect(etaOf(clock).tick("diarizing", 1)).toBe(0);
  });

  it("says nothing without a duration, or on a stage that costs no time", () => {
    const clock = { t: 0 };
    expect(new Eta({ durationMs: null, rates: FLAT }).tick("transcribing", 0.5)).toBeNull();
    expect(etaOf(clock).tick("merging", 0)).toBeNull();
  });

  it("bends towards what the machine is actually doing", () => {
    const clock = { t: 0 };
    const eta = etaOf(clock);
    eta.tick("transcribing", 0);
    // 30 s to do a tenth of a stage priced at 60 s: really 300 s, so 270 s left + diarization
    clock.t = 30_000;
    const seen = eta.tick("transcribing", 0.1)!;
    expect(seen).toBeGreaterThan(120_000);
    expect(seen).toBeLessThan(300_000);

    // by TRUST_AT the prior is gone: 150 s of transcription left, 30 s of diarization
    clock.t = 150_000;
    expect(eta.tick("transcribing", 0.5)).toBe(180_000);
  });

  it("prices a resumed stage off what it has run, not off the checkpoint it inherited", () => {
    const clock = { t: 0 };
    const eta = etaOf(clock);
    eta.tick("transcribing", 0.8); // resume point — no time has been spent on those chunks
    clock.t = 6_000; // 6 s for a tenth of a 60 s stage = exactly the predicted rate
    expect(eta.tick("transcribing", 0.9)).toBe(6_000 + 30_000);
  });

  it("restarts its stopwatch on the next stage", () => {
    const clock = { t: 0 };
    const eta = etaOf(clock);
    eta.tick("transcribing", 0);
    clock.t = 600_000; // a very slow transcription
    eta.tick("transcribing", 1);
    eta.tick("diarizing", 0);
    clock.t = 615_000; // diarization is running at twice its predicted cost
    expect(eta.tick("diarizing", 0.5)).toBe(15_000);
  });
});

describe("stage rates", () => {
  let db: Db;
  const key = rateKey("transcribing", "gpu", "large-v3-turbo");

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  it("falls back until something has been measured", () => {
    expect(rates.rate(db, key, 0.041)).toBe(0.041);
    rates.record(db, key, 60_000, 10 * MIN);
    expect(rates.rate(db, key, 0.041)).toBe(0.1);
  });

  it("weights the history over any one run", () => {
    rates.record(db, key, 60_000, 10 * MIN); // 0.1
    rates.record(db, key, 600_000, 10 * MIN); // a contended run at 1.0
    expect(rates.rate(db, key, 0)).toBeCloseTo(0.37, 5);
  });

  it("ignores clips too short to measure and impossible ratios", () => {
    rates.record(db, key, 5_000, 10_000);
    rates.record(db, key, 0, 10 * MIN);
    rates.record(db, key, 10 * MIN * 200, 10 * MIN);
    expect(rates.rate(db, key, 0.041)).toBe(0.041);
  });
});

describe("etaLabel", () => {
  it("rounds to minutes and says nothing when there is no estimate", () => {
    expect(etaLabel(null)).toBe("");
    expect(etaLabel(20_000)).toBe("<1m left");
    expect(etaLabel(4 * MIN + 20_000)).toBe("~4m left");
    expect(etaLabel(72 * MIN)).toBe("~1h 12m left");
  });
});
