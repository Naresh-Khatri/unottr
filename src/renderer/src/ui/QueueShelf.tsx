import { useCallback, useEffect, useMemo, useState } from "react";
import { CaretUp, CircleNotch, Clock, Stack } from "@phosphor-icons/react";
import {
  api,
  onJobDone,
  onJobFailed,
  onJobProgress,
  onRecordingDiscovered,
} from "@/ipc/client";
import type { RecordingSummary, Status } from "@/ipc/types";
import { IN_FLIGHT } from "@/ipc/types";
import { countdownEta, etaLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface LiveProgress {
  pct: number;
  eta: number | null;
  receivedAt: number;
}

const STAGE_LABEL: Record<Status, string> = {
  discovered: "Waiting",
  probing: "Preparing",
  extracting: "Extracting audio",
  transcribing: "Transcribing",
  diarizing: "Identifying speakers",
  merging: "Finishing",
  done: "Done",
  failed: "Failed",
};

export function QueueShelf({ onOpen }: { onOpen: (id: number) => void }) {
  const [rows, setRows] = useState<RecordingSummary[]>([]);
  const [progress, setProgress] = useState<Record<number, LiveProgress>>({});
  const [etaClock, setEtaClock] = useState(() => Date.now());
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    const next = await api.listRecordings(undefined, { by: "created_at", dir: "asc" });
    setRows(next);
  }, []);

  useEffect(() => {
    // Listen first so startup reconciliation cannot move a row between our snapshot and
    // subscription. This component stays mounted for the lifetime of the main app shell.
    const offs = [
      onJobProgress((p) => {
        setProgress((prev) => ({
          ...prev,
          [p.recording_id]: {
            pct: p.pct,
            eta: p.eta_ms,
            receivedAt: Date.now(),
          },
        }));
        setRows((prev) => prev.map((row) => (
          row.id === p.recording_id ? { ...row, status: p.stage } : row
        )));
      }),
      onJobDone(load),
      onJobFailed(load),
      onRecordingDiscovered(load),
    ];
    void load();
    return () => offs.forEach((off) => off());
  }, [load]);

  const queued = useMemo(
    () => rows.filter((row) => IN_FLIGHT.includes(row.status)),
    [rows],
  );
  const active = queued.find((row) => progress[row.id] !== undefined)
    ?? queued.find((row) => row.status !== "discovered")
    ?? queued[0];
  const waiting = active ? queued.filter((row) => row.id !== active.id) : queued;
  const activeProgress = active ? progress[active.id] : undefined;

  useEffect(() => {
    if (activeProgress?.eta == null) return undefined;
    const timer = window.setInterval(() => setEtaClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [activeProgress?.eta]);

  useEffect(() => {
    if (queued.length === 0) setOpen(false);
  }, [queued.length]);

  if (!active) return null;

  const eta = activeProgress?.eta == null
    ? ""
    : etaLabel(countdownEta(activeProgress.eta, activeProgress.receivedAt, etaClock));
  const pct = Math.min(1, Math.max(0, activeProgress?.pct ?? 0));

  return (
    <footer className="relative z-20 shrink-0 border-t bg-sidebar" aria-label="Processing queue">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <button
              type="button"
              className="flex h-11 w-full items-center gap-2.5 px-3 text-left outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4"
              aria-label={`Open processing queue, ${queued.length} ${queued.length === 1 ? "item" : "items"}`}
            />
          }
        >
          <Stack className="size-4 shrink-0 text-muted-foreground" />
          <span className="shrink-0 text-xs font-medium">Queue</span>
          <span className="h-4 w-px shrink-0 bg-border" aria-hidden="true" />
          <CircleNotch className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
          <span className="min-w-0 truncate text-xs font-medium">
            {active.title ?? active.filename}
          </span>
          <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
            {STAGE_LABEL[active.status]}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
            {eta && <span className="tabular-nums">{eta}</span>}
            {waiting.length > 0 && (
              <span>{waiting.length} waiting</span>
            )}
            <CaretUp className={cn(
              "size-3.5 transition-transform duration-200 motion-reduce:transition-none",
              open && "rotate-180",
            )} />
          </span>
        </PopoverTrigger>

        <PopoverContent
          side="top"
          align="end"
          className="w-[min(26rem,calc(100vw-1rem))]"
        >
          <div className="flex items-center justify-between border-b px-3 py-2.5">
            <div>
              <h2 className="text-sm font-medium">Processing queue</h2>
              <p className="text-xs text-muted-foreground">
                {queued.length} {queued.length === 1 ? "recording" : "recordings"}
              </p>
            </div>
            {eta && <span className="text-xs text-muted-foreground tabular-nums">{eta}</span>}
          </div>
          <div className="max-h-72 overflow-y-auto p-1.5">
            {queued.map((row) => {
              const isActive = row.id === active.id;
              const live = progress[row.id];
              return (
                <button
                  key={row.id}
                  type="button"
                  className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => {
                    setOpen(false);
                    onOpen(row.id);
                  }}
                >
                  {isActive
                    ? <CircleNotch className="mt-0.5 size-4 shrink-0 animate-spin motion-reduce:animate-none" />
                    : <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {row.title ?? row.filename}
                    </span>
                    <span className="mt-0.5 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                      <span>{isActive ? STAGE_LABEL[row.status] : "Waiting"}</span>
                      {isActive && eta && <span className="tabular-nums">{eta}</span>}
                    </span>
                    {isActive && (
                      <span className="mt-2 block h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                        <span
                          className="block size-full origin-left bg-primary transition-transform duration-200 ease-out motion-reduce:transition-none"
                          style={{ transform: `scaleX(${Math.min(1, Math.max(0, live?.pct ?? pct))})` }}
                        />
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>
      <span className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-muted" aria-hidden="true">
        <span
          className="block size-full origin-left bg-primary transition-transform duration-200 ease-out motion-reduce:transition-none"
          style={{ transform: `scaleX(${pct})` }}
        />
      </span>
      <span className="sr-only" aria-live="polite">
        {STAGE_LABEL[active.status]} {active.title ?? active.filename}{eta ? `, ${eta}` : ""}
      </span>
    </footer>
  );
}
