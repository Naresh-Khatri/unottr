import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDatabase } from "../src/main/db/client";
import { runMigrations } from "../src/main/db/migrate";
import * as queries from "../src/main/db/queries";
import * as rec from "../src/main/db/recordings";
import { segments } from "../src/main/db/schema";
import * as wf from "../src/main/db/watch-folders";
import { err } from "../src/main/errors";
import * as backfill from "../src/main/ingest/backfill";
import { type IngestConfig, defaultIngestConfig, hasExtension } from "../src/main/ingest/config";
import { compute } from "../src/main/ingest/fingerprint";
import { type IngestEvent, type RunJob, Queue } from "../src/main/ingest/queue";
import { clearStalePcmCache, stemOfCacheFile } from "../src/main/ingest/reconcile";
import {
  type Candidates,
  promote,
  relist,
  stepCandidates,
  sweepMissing,
} from "../src/main/ingest/watch";
import { discover } from "../src/main/media/ffmpeg";

const root = mkdtempSync(join(tmpdir(), "unottr-ingest-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const cli = discover();
const haveFfmpeg = spawnSync(cli.ffmpeg, ["-version"], { stdio: "ignore" }).status === 0;

let db: Db;
let dir: string;
let seq = 0;

beforeEach(() => {
  db = openDatabase(":memory:");
  runMigrations(db);
  dir = join(root, `case-${++seq}`);
  mkdirSync(dir, { recursive: true });
});

/** A tiny real mp4 — one video stream, one audio stream. */
function fixture(out: string, seconds = 1): void {
  const r = spawnSync(
    cli.ffmpeg,
    [
      ...["-v", "error", "-y"],
      ...["-f", "lavfi", "-i", `color=c=black:s=64x64:d=${seconds}`],
      ...["-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`],
      ...["-map", "0:v", "-map", "1:a", "-pix_fmt", "yuv420p"],
      out,
    ],
    { stdio: "ignore" },
  );
  if (r.status !== 0) throw new Error("building fixture failed");
}

/** Tight counters so a test drives promotion in a handful of ticks instead of dozens. */
const quick = (): IngestConfig => ({
  ...defaultIngestConfig(),
  stableRequiredCount: 2,
  maxProbeChecks: 2,
});

// ------------------------------------------------------------------------- fingerprint

describe("fingerprint", () => {
  it("matches identical content and separates a single changed byte", async () => {
    const a = join(dir, "a.bin");
    const b = join(dir, "b.bin");
    const c = join(dir, "c.bin");
    writeFileSync(a, Buffer.alloc(4096, 7));
    writeFileSync(b, Buffer.alloc(4096, 7));
    const changed = Buffer.alloc(4096, 7);
    changed[0] = 8;
    writeFileSync(c, changed);

    const [fa, fb, fc] = await Promise.all([compute(a), compute(b), compute(c)]);
    expect(fa.size).toBe(4096);
    expect(fa.head.equals(fb.head)).toBe(true);
    expect(fa.tail.equals(fb.tail)).toBe(true);
    expect(fa.head.equals(fc.head)).toBe(false);
  });

  it("hashes the same bytes twice for a file under the chunk size", async () => {
    const p = join(dir, "tiny.bin");
    writeFileSync(p, "hello");
    const fp = await compute(p);
    expect(fp.head.equals(fp.tail)).toBe(true);
    expect(fp.size).toBe(5);
  });

  it("cannot tell apart two large files that differ only in the middle", async () => {
    const mib = 1 << 20;
    const one = Buffer.alloc(3 * mib, 1);
    const two = Buffer.from(one);
    two[mib + 10] = 9;
    const a = join(dir, "big-a.bin");
    const b = join(dir, "big-b.bin");
    writeFileSync(a, one);
    writeFileSync(b, two);
    const [fa, fb] = await Promise.all([compute(a), compute(b)]);
    // documented trade-off: head + tail + size, never the whole file
    expect(fa.head.equals(fb.head) && fa.tail.equals(fb.tail) && fa.size === fb.size).toBe(true);
  });

  it("reports a missing file as an io error", async () => {
    await expect(compute(join(dir, "nope.bin"))).rejects.toMatchObject({ slug: "io_error" });
  });
});

// ------------------------------------------------------------------------------ config

describe("extension matching", () => {
  const cfg = defaultIngestConfig();

  it("is case-insensitive", () => {
    expect(hasExtension(cfg, "/x/a.MKV")).toBe(true);
    expect(hasExtension(cfg, "/x/a.mp4")).toBe(true);
  });

  it("rejects anything not on the list", () => {
    expect(hasExtension(cfg, "/x/notes.txt")).toBe(false);
    expect(hasExtension(cfg, "/x/README")).toBe(false);
    expect(hasExtension(cfg, "/x/.mkv")).toBe(false);
  });
});

// --------------------------------------------------------------------------- reconcile

describe("pcm cache names", () => {
  it("recovers the stem a cache file belongs to", () => {
    expect(stemOfCacheFile("meeting.t12.pcm")).toBe("meeting");
    expect(stemOfCacheFile("meeting.mix.pcm")).toBe("meeting");
    expect(stemOfCacheFile("2025-10-08 11.56.33.t0.pcm")).toBe("2025-10-08 11.56.33");
    expect(stemOfCacheFile("meeting.pcm")).toBeNull();
    expect(stemOfCacheFile("meeting.tx.pcm")).toBeNull();
    expect(stemOfCacheFile("meeting.t0.wav")).toBeNull();
  });

  it("keeps cache belonging to a non-terminal row and drops the rest", () => {
    const cache = join(dir, "pcm");
    mkdirSync(cache);
    rec.stub(db, join(dir, "live.mkv")); // stub rows land in a non-terminal status
    for (const name of ["live.t0.pcm", "live.mix.pcm", "gone.t0.pcm", "notes.txt"]) {
      writeFileSync(join(cache, name), "x");
    }

    clearStalePcmCache(db, cache);

    expect(existsSync(join(cache, "live.t0.pcm"))).toBe(true);
    expect(existsSync(join(cache, "live.mix.pcm"))).toBe(true);
    expect(existsSync(join(cache, "gone.t0.pcm"))).toBe(false);
    expect(existsSync(join(cache, "notes.txt"))).toBe(true); // not ours to delete
  });
});

// ------------------------------------------------------------------------------- watch

describe.skipIf(!haveFfmpeg)("candidate promotion", () => {
  const cfg = quick();

  it("does not queue a file that is still being written", async () => {
    const whole = join(dir, "whole.mp4");
    fixture(whole, 2);
    const bytes = readFileSync(whole);
    const growing = join(dir, "growing.mp4");
    writeFileSync(growing, bytes.subarray(0, bytes.length >> 2));
    rmSync(whole);

    const discovered: number[] = [];
    const candidates: Candidates = new Map();
    relist(db, dir, cfg, candidates);

    // grows through several ticks: every size change restarts the stability count
    for (let i = 2; i <= 3; i++) {
      await stepCandidates(db, cli, cfg, candidates, (id) => discovered.push(id));
      appendFileSync(growing, bytes.subarray((bytes.length >> 2) * (i - 1), (bytes.length >> 2) * i));
    }
    // and holding a truncated file still is not enough — ffprobe reads no duration
    for (let i = 0; i < cfg.stableRequiredCount + cfg.maxProbeChecks - 1; i++) {
      await stepCandidates(db, cli, cfg, candidates, (id) => discovered.push(id));
    }
    expect(discovered).toEqual([]);
    expect(rec.findByPath(db, growing)).toBeNull();

    // the rest of the file arrives; now it settles and probes clean
    writeFileSync(growing, bytes);
    for (let i = 0; i < cfg.stableRequiredCount + 1; i++) {
      await stepCandidates(db, cli, cfg, candidates, (id) => discovered.push(id));
    }
    expect(discovered).toHaveLength(1);
    expect(rec.findByPath(db, growing)).toBe(discovered[0]);
    expect(rec.statusOf(db, discovered[0])).toBe("discovered");
  });

  it("queues a file that never probes, so it fails visibly instead of waiting forever", async () => {
    const garbage = join(dir, "garbage.mp4");
    writeFileSync(garbage, Buffer.alloc(2048, 3));

    const discovered: number[] = [];
    const candidates: Candidates = new Map();
    relist(db, dir, cfg, candidates);
    for (let i = 0; i < cfg.stableRequiredCount + cfg.maxProbeChecks + 1; i++) {
      await stepCandidates(db, cli, cfg, candidates, (id) => discovered.push(id));
    }
    expect(discovered).toHaveLength(1);
    expect(candidates.size).toBe(0);
  });

  it("drops a candidate that vanishes before it settles", async () => {
    const p = join(dir, "ghost.mp4");
    writeFileSync(p, Buffer.alloc(1024, 1));
    const candidates: Candidates = new Map();
    relist(db, dir, cfg, candidates);
    rmSync(p);
    await stepCandidates(db, cli, cfg, candidates, () => {});
    expect(candidates.size).toBe(0);
  });
});

describe("identity", () => {
  it("re-links a renamed file instead of discovering it again", async () => {
    const before = join(dir, "before.mkv");
    writeFileSync(before, Buffer.alloc(2048, 5));
    const discovered: number[] = [];
    await promote(db, before, (id) => discovered.push(id));
    const id = discovered[0];
    rec.setStatus(db, id, "done");
    db.insert(segments)
      .values({ recordingId: id, chunkIdx: 0, startMs: 0, endMs: 500, text: "hello" })
      .run();

    const after = join(dir, "after.mkv");
    renameSync(before, after);
    await promote(db, after, (id2) => discovered.push(id2));

    expect(discovered).toEqual([id]); // no second discovery, so no second job
    expect(rec.findByPath(db, after)).toBe(id);
    expect(rec.statusOf(db, id)).toBe("done"); // never reprocessed
    expect(db.select().from(segments).all()).toHaveLength(1);
  });

  it("marks a vanished file unavailable but finds it first if it only moved", async () => {
    const other = join(dir, "other");
    mkdirSync(other);
    wf.add(db, dir);
    wf.add(db, other);
    const path = join(dir, "moved.mkv");
    writeFileSync(path, Buffer.alloc(4096, 6));
    const discovered: number[] = [];
    await promote(db, path, (id) => discovered.push(id));
    const id = discovered[0];

    const moved = join(other, "renamed.mkv");
    renameSync(path, moved);
    await sweepMissing(db, [dir, other]);
    expect(rec.findByPath(db, moved)).toBe(id);
    expect(rec.availablePaths(db).map((r) => r.path)).toEqual([moved]);

    db.insert(segments)
      .values({ recordingId: id, chunkIdx: 0, startMs: 0, endMs: 500, text: "quarterly numbers" })
      .run();
    rmSync(moved);
    await sweepMissing(db, [dir, other]);
    expect(rec.availablePaths(db)).toEqual([]);
    // the transcript outlives the file — searching it must still work
    expect(queries.search(db, "quarterly", 10).map((h) => h.recording_id)).toEqual([id]);
  });

  it("restores a row when its file reappears where it was", () => {
    const path = join(dir, "back.mkv");
    writeFileSync(path, "x");
    const id = rec.stub(db, path);
    rec.markUnavailable(db, id);
    relist(db, dir, defaultIngestConfig(), new Map());
    expect(rec.availablePaths(db).map((r) => r.id)).toEqual([id]);
  });
});

// ---------------------------------------------------------------------------- backfill

describe.skipIf(!haveFfmpeg)("backfill", () => {
  it("counts and estimates without touching the database", async () => {
    fixture(join(dir, "one.mp4"), 1);
    fixture(join(dir, "two.mp4"), 1);
    writeFileSync(join(dir, "notes.txt"), "ignored");

    const cfg = defaultIngestConfig();
    const est = await backfill.scan(dir, cfg, cli);
    expect(est.count).toBe(2);
    expect(est.total_duration_ms).toBeGreaterThan(1500);
    expect(est.estimated_processing_ms).toBe(Math.trunc(est.total_duration_ms * cfg.realtimeFactor));
    expect(rec.nonTerminal(db)).toEqual([]); // read-only until confirmed
  });

  it("inserts each new file once and re-links a moved one", async () => {
    fixture(join(dir, "one.mp4"), 1);
    const cfg = defaultIngestConfig();

    const ids = await backfill.confirm(db, dir, cfg);
    expect(ids).toHaveLength(1);
    expect(await backfill.confirm(db, dir, cfg)).toEqual([]); // already known by path

    renameSync(join(dir, "one.mp4"), join(dir, "renamed.mp4"));
    expect(await backfill.confirm(db, dir, cfg)).toEqual([]); // known by fingerprint
    expect(rec.findByPath(db, join(dir, "renamed.mp4"))).toBe(ids[0]);
  });
});

// ------------------------------------------------------------------------------- queue

describe("queue", () => {
  const collect = (events: IngestEvent[]) => (e: IngestEvent) => {
    events.push(e);
  };

  const queueOf = (events: IngestEvent[], run: RunJob, maxAttempts = 3): Queue =>
    new Queue({ db, maxAttempts, run, onEvent: collect(events) });

  it("runs one job at a time and reports done", async () => {
    const a = rec.stub(db, join(dir, "a.mkv"));
    const b = rec.stub(db, join(dir, "b.mkv"));
    const events: IngestEvent[] = [];
    let inFlight = 0;
    const q = queueOf(events, async (_id, onProgress) => {
      inFlight += 1;
      expect(inFlight).toBe(1);
      onProgress("probing", 0.5);
      await Promise.resolve();
      inFlight -= 1;
    });
    q.enqueue(a);
    q.enqueue(b);
    q.enqueue(a); // already queued
    await q.idle();

    expect(events.filter((e) => e.kind === "done").map((e) => e.recording_id)).toEqual([a, b]);
    expect(events.filter((e) => e.kind === "progress")).toHaveLength(2);
  });

  it("retries a bounded failure up to max_attempts, then parks it", async () => {
    const id = rec.stub(db, join(dir, "bounded.mkv"));
    const events: IngestEvent[] = [];
    let runs = 0;
    const q = queueOf(events, async () => {
      runs += 1;
      throw err.probe("bounded.mkv", "ffprobe blew up");
    });
    q.enqueue(id);
    await q.idle();

    expect(runs).toBe(3);
    expect(events).toEqual([{ kind: "failed", recording_id: id, error: "probe_failed" }]);
    expect(rec.statusOf(db, id)).toBe("failed");
  });

  it("parks a terminal failure on the first attempt", async () => {
    const id = rec.stub(db, join(dir, "half.mp4"));
    const events: IngestEvent[] = [];
    let runs = 0;
    const q = queueOf(events, async () => {
      runs += 1;
      throw err.truncated("half.mp4");
    });
    q.enqueue(id);
    await q.idle();

    expect(runs).toBe(1);
    expect(events).toEqual([{ kind: "failed", recording_id: id, error: "truncated" }]);
  });

  it("forces cpu and retries once on a gpu oom, then gives up", async () => {
    const id = rec.stub(db, join(dir, "oom.mkv"));
    const events: IngestEvent[] = [];
    const forced: boolean[] = [];
    // the device switch is not an attempt, so max_attempts 1 still allows the cpu run
    const q = queueOf(
      events,
      async () => {
        forced.push(rec.forceCpuOf(db, id));
        throw err.gpuOom();
      },
      1,
    );
    q.enqueue(id);
    await q.idle();

    expect(forced).toEqual([false, true]); // the retry sees the persisted override
    expect(rec.forceCpuOf(db, id)).toBe(true);
    expect(events.at(-1)).toEqual({ kind: "failed", recording_id: id, error: "gpu_oom" });
  });

  it("leaves a cancelled job exactly as it was", async () => {
    const id = rec.stub(db, join(dir, "shutdown.mkv"));
    rec.setStatus(db, id, "transcribing");
    const events: IngestEvent[] = [];
    const q = queueOf(events, async () => {
      throw err.cancelled();
    });
    q.enqueue(id);
    await q.idle();

    expect(events).toEqual([]);
    expect(rec.statusOf(db, id)).toBe("transcribing"); // reconciliation picks it back up
  });
});
