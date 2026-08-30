import { useCallback, useEffect, useMemo, useState } from "react";
import { CaretUp, CircleNotch, Clock, Stack, X } from "@phosphor-icons/react";
import {
  api,
  onJobDone,
  onJobFailed,
  onRecordingDiscovered,
} from "@/ipc/client";
import type { RecordingSummary } from "@/ipc/types";
import { IN_FLIGHT } from "@/ipc/types";
import { isTtsVoiceDownload } from "@/ipc/types";
import { countdownEta, etaLabel } from "@/lib/format";
import { jobActivity, jobPhaseOf, modelPhaseLabel } from "@/lib/activity";
import { useActivities } from "@/lib/ActivityProvider";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ActivityBar, ActivityMark } from "@/components/activity-indicator";

export function QueueShelf({ onOpen }: { onOpen: (id: number) => void }) {
  const [rows, setRows] = useState<RecordingSummary[]>([]);
  const {
    jobs: progress,
    modelDownloads,
    backfills,
    incomingFiles,
    actions,
    dismissAction,
  } = useActivities();
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
      onJobDone(load),
      onJobFailed(load),
      onRecordingDiscovered(load),
    ];
    void load();
    return () => offs.forEach((off) => off());
  }, [load]);

  useEffect(() => {
    setRows((current) => current.map((row) => {
      const live = progress[row.id];
      return live ? { ...row, status: live.stage, stage_detail: live.phase } : row;
    }));
  }, [progress]);

  const queued = useMemo(
    () => rows.filter((row) => IN_FLIGHT.includes(row.status)),
    [rows],
  );
  const running = queued.find((row) => progress[row.id]?.phase !== "queued" && progress[row.id] !== undefined)
    ?? queued.find((row) => progress[row.id] === undefined && row.status !== "discovered")
    ?? null;
  const active = running ?? queued[0];
  const activeProgress = active ? progress[active.id] : undefined;

  useEffect(() => {
    if (activeProgress?.eta_ms == null) return undefined;
    const timer = window.setInterval(() => setEtaClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [activeProgress?.eta_ms]);

  useEffect(() => {
    if (queued.length === 0) setOpen(false);
  }, [queued.length]);

  const backgroundModels = Object.values(modelDownloads).filter((item) => item.phase !== "done" && !item.error);
  const backgroundBackfills = Object.values(backfills).filter((item) => item.phase !== "done" && !item.error);
  const backgroundIncoming = Object.values(incomingFiles);
  const backgroundActions = actions;
  const backgroundCount = backgroundModels.length + backgroundBackfills.length
    + backgroundIncoming.length + backgroundActions.length;

  if (!active && backgroundCount === 0) return null;

  const eta = activeProgress?.eta_ms == null
    ? ""
    : etaLabel(countdownEta(activeProgress.eta_ms, activeProgress.receivedAt, etaClock));
  const pct = Math.min(1, Math.max(0, activeProgress?.pct ?? 0));
  const activePhase = activeProgress?.phase ?? jobPhaseOf(active?.stage_detail);
  const activeView = active
    ? jobActivity(active.status, activePhase, activeProgress?.mode, active.duration_ms)
    : null;
  const primaryModel = backgroundModels[0];
  const primaryBackfill = backgroundBackfills[0];
  const primaryIncoming = backgroundIncoming[0];
  const primaryAction = backgroundActions[0];
  const primaryState = active || primaryModel || primaryBackfill || primaryIncoming
    ? "running"
    : primaryAction?.state ?? "running";
  const primaryLabel = active
    ? active.title ?? active.filename
    : primaryModel
      ? primaryModel.model === "support"
        ? "Support models"
        : isTtsVoiceDownload(primaryModel.model) ? "Speech voice" : `${primaryModel.model} model`
      : primaryBackfill ? "Adding existing recordings"
        : primaryIncoming?.filename ?? primaryAction?.label ?? "Background work";
  const primaryDetail = activeView?.label
    ?? (primaryModel ? modelPhaseLabel(primaryModel.phase) : null)
    ?? (primaryBackfill
      ? primaryBackfill.phase === "fingerprinting" ? "Checking existing files" : "Adding recordings to the queue"
      : null)
    ?? (primaryIncoming
      ? primaryIncoming.phase === "checking_file" ? "Checking recording" : "Waiting for copy to finish"
      : null)
    ?? (primaryAction
      ? primaryAction.state === "done"
        ? "Finished"
        : primaryAction.state === "error" ? primaryAction.error ?? "Could not finish" : primaryAction.detail
      : null)
    ?? "Working";
  const primaryValue = active
    ? pct
    : primaryModel?.pct
      ?? (primaryBackfill && primaryBackfill.total > 0
        ? primaryBackfill.done / primaryBackfill.total
        : primaryIncoming && primaryIncoming.total > 0
          ? primaryIncoming.done / primaryIncoming.total
          : primaryAction?.state === "done" ? 1 : 0);
  const primaryIndeterminate = activeView?.indeterminate
    ?? (primaryModel
      ? primaryModel.phase !== "downloading"
      : primaryBackfill
        ? primaryBackfill.total === 0
        : primaryIncoming
          ? primaryIncoming.phase === "checking_file"
          : primaryAction?.state === "running");
  const totalItems = queued.length + backgroundCount;

  return (
    <footer className="relative z-20 shrink-0 border-t bg-sidebar" aria-label="Background activity">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <button
              type="button"
              className="flex h-11 w-full items-center gap-2.5 px-3 text-left outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4"
              aria-label={`Open background activity, ${totalItems} ${totalItems === 1 ? "item" : "items"}`}
            />
          }
        >
          <Stack className="size-4 shrink-0 text-muted-foreground" />
          <span className="shrink-0 text-xs font-medium">Activity</span>
          <span className="h-4 w-px shrink-0 bg-border" aria-hidden="true" />
          <ActivityMark state={primaryState} className="size-3.5" />
          <span className="min-w-0 truncate text-xs font-medium">
            {primaryLabel}
          </span>
          <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
            {primaryDetail}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
            {eta && <span className="tabular-nums">{eta}</span>}
            {totalItems > 1 && (
              <span>{totalItems - 1} more</span>
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
              <h2 className="text-sm font-medium">Background activity</h2>
              <p className="text-xs text-muted-foreground">
                Work continues while you use the app
              </p>
            </div>
            {eta && <span className="text-xs text-muted-foreground tabular-nums">{eta}</span>}
          </div>
          <div className="max-h-72 overflow-y-auto p-1.5">
            {queued.map((row) => {
              const isActive = row.id === running?.id;
              const live = progress[row.id];
              const phase = live?.phase ?? jobPhaseOf(row.stage_detail);
              const view = jobActivity(row.status, phase, live?.mode, row.duration_ms);
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
                      <span>{view.label}</span>
                      {isActive && eta && <span className="tabular-nums">{eta}</span>}
                    </span>
                    {isActive && (
                      <ActivityBar
                        value={live?.pct ?? pct}
                        indeterminate={view.indeterminate}
                        className="mt-2"
                      />
                    )}
                  </span>
                </button>
              );
            })}
            {queued.length > 0 && backgroundCount > 0 && <div className="my-1 border-t" />}
            {backgroundModels.map((item) => (
              <div key={`model:${item.model}`} className="px-2 py-2">
                <div className="flex items-center gap-2.5">
                  <ActivityMark className="mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">
                      {item.model === "support" ? "Support models" : `${item.model} model`}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {modelPhaseLabel(item.phase)}
                    </div>
                    <ActivityBar
                      value={item.pct}
                      indeterminate={item.phase !== "downloading"}
                      className="mt-2"
                    />
                  </div>
                </div>
              </div>
            ))}
            {backgroundBackfills.map((item) => (
              <div key={`backfill:${item.folder_id}`} className="px-2 py-2">
                <div className="flex items-center gap-2.5">
                  <ActivityMark className="mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">Adding existing recordings</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {item.phase === "fingerprinting" ? "Checking files" : "Adding to queue"}
                      {item.total > 0 ? ` · ${item.done} of ${item.total}` : ""}
                    </div>
                    <ActivityBar
                      value={item.total > 0 ? item.done / item.total : 0}
                      indeterminate={item.total === 0}
                      className="mt-2"
                    />
                  </div>
                </div>
              </div>
            ))}
            {backgroundIncoming.map((item) => (
              <div key={`incoming:${item.path}`} className="px-2 py-2">
                <div className="flex items-center gap-2.5">
                  <ActivityMark className="mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{item.filename}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {item.phase === "checking_file" ? "Checking recording" : "Waiting for copy to finish"}
                    </div>
                    <ActivityBar
                      value={item.total > 0 ? item.done / item.total : 0}
                      indeterminate={item.phase === "checking_file"}
                      className="mt-2"
                    />
                  </div>
                </div>
              </div>
            ))}
            {backgroundActions.map((item) => (
              <div key={item.id} className="px-2 py-2">
                <div className="flex items-start gap-2.5">
                  <ActivityMark state={item.state} className="mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{item.label}</div>
                    {(item.error || item.detail) && (
                      <div className={cn(
                        "mt-0.5 text-xs text-muted-foreground",
                        item.error && "text-destructive",
                      )}>
                        {item.error ?? item.detail}
                      </div>
                    )}
                    {item.state === "running" && <ActivityBar indeterminate className="mt-2" />}
                  </div>
                  {item.state !== "running" && (
                    <button
                      type="button"
                      className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`Dismiss ${item.label}`}
                      onClick={() => dismissAction(item.id)}
                    >
                      <X className="size-3.5" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      <ActivityBar
        value={primaryValue}
        indeterminate={primaryIndeterminate}
        className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 rounded-none"
      />
      <span className="sr-only" aria-live="polite">
        {primaryDetail} {primaryLabel}{eta ? `, ${eta}` : ""}
      </span>
    </footer>
  );
}
