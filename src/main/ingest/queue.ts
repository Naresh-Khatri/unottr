// Port of crates/unottr-core/src/ingest/worker.rs. Concurrency 1 on purpose — whisper on the
// gpu saturates the device, so a second job just thrashes vram and both finish later.
//
// The rust worker was a thread blocking on a channel; here it is a promise chain driven by
// `enqueue`. The job body is injected so this file never imports electron and stays testable.

import type { Status } from "../../shared/ipc";
import type { Db } from "../db/client";
import { failOrRetry, forceCpuOf, setForceCpu } from "../db/recordings";
import { PipelineError, err, isCancelled } from "../errors";

export type IngestEvent =
  | { kind: "discovered"; recording_id: number }
  | { kind: "progress"; recording_id: number; stage: Status; pct: number; eta_ms: number | null }
  | { kind: "done"; recording_id: number }
  | { kind: "failed"; recording_id: number; error: string };

export type RunJob = (
  id: number,
  onProgress: (stage: Status, pct: number, etaMs: number | null) => void,
  signal: AbortSignal,
) => Promise<void>;

export interface QueueOptions {
  db: Db;
  maxAttempts: number;
  run: RunJob;
  onEvent: (event: IngestEvent) => void;
}

export class Queue {
  private readonly pending: number[] = [];
  /** Ids queued or currently running — a second enqueue of either is a no-op. */
  private readonly known = new Set<number>();
  private readonly controller = new AbortController();
  private current: Promise<void> | null = null;

  constructor(private readonly o: QueueOptions) {}

  enqueue(id: number): void {
    if (this.controller.signal.aborted || this.known.has(id)) return;
    this.known.add(id);
    this.pending.push(id);
    this.pump();
  }

  /** Signals shutdown and waits for the running job to reach its next checkpoint. */
  async shutdown(): Promise<void> {
    this.controller.abort();
    this.pending.length = 0;
    await this.current;
  }

  /** Test hook: resolves once the queue has drained. */
  async idle(): Promise<void> {
    while (this.current) await this.current;
  }

  private pump(): void {
    if (this.current || this.controller.signal.aborted) return;
    const id = this.pending.shift();
    if (id === undefined) return;
    this.current = this.runJob(id).finally(() => {
      this.known.delete(id);
      this.current = null;
      this.pump();
    });
  }

  private async runJob(id: number): Promise<void> {
    const { db, maxAttempts, run, onEvent } = this.o;
    const signal = this.controller.signal;
    // read back rather than assumed false: a previous run may already have forced cpu for
    // this recording, and that one automatic retry is not owed twice
    let forcedCpu = forceCpuOf(db, id);

    for (;;) {
      if (signal.aborted) return;
      try {
        await run(
          id,
          (stage, pct, eta_ms) => onEvent({ kind: "progress", recording_id: id, stage, pct, eta_ms }),
          signal,
        );
        onEvent({ kind: "done", recording_id: id });
        return;
      } catch (e) {
        // graceful shutdown: leave status/checkpoint exactly as they are, the next startup's
        // reconciliation picks this row back up
        if (isCancelled(e) || signal.aborted) return;
        const error = e instanceof PipelineError ? e : err.db(e);
        // only the slug reaches the db and the ui; without this the message is lost for good
        console.warn(`recording ${id} failed: ${error.message}`);

        // 07's gpu_oom decision: silent to the user, one automatic cpu retry. Bypasses
        // failOrRetry entirely — this is a transparent device switch, not an attempt.
        if (error.slug === "gpu_oom" && !forcedCpu) {
          forcedCpu = true;
          setForceCpu(db, id, true);
          continue;
        }

        const willRetry = failOrRetry(db, id, error.slug, (attempts) =>
          parks(error, attempts, maxAttempts),
        );
        if (willRetry) continue;
        onEvent({ kind: "failed", recording_id: id, error: error.slug });
        return;
      }
    }
  }
}

/** `bounded` gets `maxAttempts` tries; the other two policies park on the first failure. */
const parks = (e: PipelineError, attempts: number, maxAttempts: number): boolean =>
  e.retryPolicy !== "bounded" || attempts >= maxAttempts;
