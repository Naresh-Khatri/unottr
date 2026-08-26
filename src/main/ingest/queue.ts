// Port of crates/unottr-core/src/ingest/worker.rs. Concurrency 1 on purpose — whisper on the
// gpu saturates the device, so a second job just thrashes vram and both finish later.
//
// The rust worker was a thread blocking on a channel; here it is a promise chain driven by
// `enqueue`. The job body is injected so this file never imports electron and stays testable.

import type { Status } from "../../shared/ipc";
import type { Db } from "../db/client";
import {
  failOrRetry,
  forceCpuOf,
  resetForSourceChange,
  setForceCpu,
} from "../db/recordings";
import { PipelineError, err, isCancelled } from "../errors";
import { SourceChangedError, waitForStableSource } from "./source";

export type IngestEvent =
  | { kind: "discovered"; recording_id: number }
  | {
      kind: "progress";
      recording_id: number;
      stage: Status;
      pct: number;
      eta_ms: number | null;
      mode: "full" | "transcribe" | "diarize";
    }
  | { kind: "done"; recording_id: number }
  | { kind: "failed"; recording_id: number; error: string };

/**
 * What to run for a queued id. The two explicit reruns do only the requested compute step;
 * newly discovered recordings still run the full ingest.
 */
export type JobSpec =
  | { kind: "full" }
  | { kind: "retranscribe" }
  | { kind: "rediarize"; speakers: number | null };

export const FULL: JobSpec = { kind: "full" };

export type RunJob = (
  id: number,
  spec: JobSpec,
  onProgress: (stage: Status, pct: number, etaMs: number | null) => void,
  signal: AbortSignal,
) => Promise<void>;

export interface QueueOptions {
  db: Db;
  maxAttempts: number;
  run: RunJob;
  onEvent: (event: IngestEvent) => void;
  sourcePollIntervalMs?: number;
  sourceStableCount?: number;
}

export class Queue {
  private readonly pending: { id: number; spec: JobSpec }[] = [];
  /** Ids queued or currently running — a second enqueue of either is a no-op. */
  private readonly known = new Set<number>();
  private readonly controller = new AbortController();
  private current: Promise<void> | null = null;

  constructor(private readonly o: QueueOptions) {}

  enqueue(id: number, spec: JobSpec = FULL): void {
    if (this.controller.signal.aborted || this.known.has(id)) return;
    this.known.add(id);
    this.pending.push({ id, spec });
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
    const next = this.pending.shift();
    if (next === undefined) return;
    const { id, spec } = next;
    this.current = this.runJob(id, spec).finally(() => {
      this.known.delete(id);
      this.current = null;
      this.pump();
    });
  }

  private async runJob(id: number, spec: JobSpec): Promise<void> {
    const { db, maxAttempts, run, onEvent } = this.o;
    const signal = this.controller.signal;
    const mode = spec.kind === "rediarize"
      ? "diarize"
      : spec.kind === "retranscribe" ? "transcribe" : "full";

    // a re-diarize runs against a recording that is already done: it must not be able to park
    // that row as failed, retry it, or switch its device — it just reports and leaves
    if (spec.kind === "rediarize") {
      try {
        await run(id, spec, (stage, pct, eta_ms) =>
          onEvent({ kind: "progress", recording_id: id, stage, pct, eta_ms, mode }),
        signal);
        onEvent({ kind: "done", recording_id: id });
      } catch (e) {
        if (isCancelled(e) || signal.aborted) return;
        const error = e instanceof PipelineError ? e : err.db(e);
        console.warn(`re-diarize of recording ${id} failed: ${error.message}`);
        onEvent({ kind: "failed", recording_id: id, error: error.slug });
      }
      return;
    }

    // read back rather than assumed false: a previous run may already have forced cpu for
    // this recording, and that one automatic retry is not owed twice
    let forcedCpu = forceCpuOf(db, id);

    for (;;) {
      if (signal.aborted) return;
      try {
        await run(
          id,
          spec,
          (stage, pct, eta_ms) =>
            onEvent({ kind: "progress", recording_id: id, stage, pct, eta_ms, mode }),
          signal,
        );
        onEvent({ kind: "done", recording_id: id });
        return;
      } catch (caught) {
        let e = caught;
        // graceful shutdown: leave status/checkpoint exactly as they are, the next startup's
        // reconciliation picks this row back up
        if (isCancelled(e) || signal.aborted) return;

        if (e instanceof SourceChangedError) {
          resetForSourceChange(db, id);
          try {
            await waitForStableSource(e.path, {
              pollIntervalMs: this.o.sourcePollIntervalMs ?? 2_000,
              requiredCount: this.o.sourceStableCount ?? 15,
              signal,
            });
            continue;
          } catch (waitError) {
            if (isCancelled(waitError) || signal.aborted) return;
            e = waitError;
          }
        }

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
