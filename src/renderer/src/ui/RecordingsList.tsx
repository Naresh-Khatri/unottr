import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowClockwise, FileX, FilmSlate, FolderOpen, Gear, Play, Users, Waveform,
} from "@phosphor-icons/react";
import {
  api, onJobDone, onJobFailed, onJobProgress, onOverviewChanged, onRecordingDiscovered,
  PREVIEW_COUNT, previewUrl, thumbUrl,
} from "@/ipc/client";
import type { RecordingSummary, WatchFolder } from "@/ipc/types";
import { IN_FLIGHT } from "@/ipc/types";
import { dateLabel, durationLabel, etaLabel, hms, timeLabel } from "@/lib/format";
import { errorInfo } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { useVirtual } from "@/lib/virtual";
import { StatusChip } from "@/ui/StatusChip";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const ROW_ESTIMATE = 72; // measured hook corrects this once rows with progress/error mount
const COLS = 7;

const TILE = "relative aspect-video w-24 shrink-0 overflow-hidden rounded-md border bg-muted";

/** Preview i sits at (i+1)/(PREVIEW_COUNT+1) of the file — mirrors extractThumbnails' spacing. */
const frameMs = (durationMs: number, i: number): number =>
  (durationMs * (i + 1)) / (PREVIEW_COUNT + 1);

/**
 * Cover frame at rest; sliding the pointer across the tile scrubs the PREVIEW_COUNT frames and
 * a click opens the transcript at the frame under the cursor. `row.status` is only read to reset
 * `available` on each stage change — thumbnails land during probing, so a freshly discovered
 * row's first paint 404s and should retry once the job moves past it.
 */
function Preview({ row, onOpenAt }: { row: RecordingSummary; onOpenAt: (ms: number) => void }) {
  const [frame, setFrame] = useState<number | null>(null); // null = not scrubbing
  const [available, setAvailable] = useState(true);
  const warmed = useRef(false);

  useEffect(() => setAvailable(true), [row.status]);

  if (!row.has_video || !available) return <Placeholder row={row} />;

  const at = frame === null ? 0 : frameMs(row.duration_ms ?? 0, frame);

  return (
    <div
      className={cn(TILE, "cursor-ew-resize ring-ring/60 transition-shadow group-hover/row:ring-2")}
      onPointerEnter={() => {
        // scrubbing has to feel instant, so pull every frame into the cache on first hover
        if (warmed.current) return;
        warmed.current = true;
        for (let i = 0; i < PREVIEW_COUNT; i++) new Image().src = previewUrl(row.id, i);
      }}
      onPointerMove={(e) => {
        const box = e.currentTarget.getBoundingClientRect();
        const i = Math.floor(((e.clientX - box.left) / box.width) * PREVIEW_COUNT);
        setFrame(Math.min(PREVIEW_COUNT - 1, Math.max(0, i)));
      }}
      onPointerLeave={() => setFrame(null)}
      onClick={(e) => {
        e.stopPropagation(); // the row itself opens at 0:00
        onOpenAt(at);
      }}
    >
      <img
        src={frame === null ? thumbUrl(row.id) : previewUrl(row.id, frame)}
        alt=""
        draggable={false}
        className="size-full object-cover"
        onError={(e) => {
          // a preview 404 mid-scrub just holds the cover frame instead of a broken-image icon;
          // the cover frame itself missing is what falls back to the placeholder
          if (frame !== null) (e.target as HTMLImageElement).src = thumbUrl(row.id);
          else setAvailable(false);
        }}
      />
      <div className="pointer-events-none absolute inset-0 flex flex-col justify-end bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 transition-opacity group-hover/row:opacity-100">
        <div className="flex items-center gap-1 p-1">
          <Play weight="fill" className="size-2.5 shrink-0 text-white" />
          {frame !== null && row.duration_ms ? (
            <span className="text-[10px] font-medium tabular-nums text-white">{hms(at)}</span>
          ) : null}
        </div>
      </div>
      {frame !== null && (
        <div className="pointer-events-none absolute inset-x-1 bottom-1 flex gap-px">
          {Array.from({ length: PREVIEW_COUNT }, (_, i) => (
            <span
              key={i}
              className={cn("h-0.5 flex-1 rounded-full", i <= frame ? "bg-white" : "bg-white/35")}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Same footprint as the real tile, so a mixed list stays on one grid. */
function Placeholder({ row }: { row: RecordingSummary }) {
  const waiting = row.has_video && (row.status === "discovered" || IN_FLIGHT.includes(row.status));
  const Icon = !row.available ? FileX : row.has_video ? FilmSlate : Waveform;
  return (
    <div className={cn(TILE, "grid place-items-center border-dashed", waiting && "animate-pulse")}>
      <Icon className="size-4 text-muted-foreground" />
    </div>
  );
}

/**
 * Row-level re-run, one per recording. Backend decides what that means per state: a failed row
 * resumes from its checkpoint, a done one transcribes from scratch. Hidden while in flight —
 * the status chip is already spinning there and retry_job would no-op anyway.
 */
function RetryAction({ row, onRetried }: { row: RecordingSummary; onRetried: () => void }) {
  const [pending, setPending] = useState(false);
  if (IN_FLIGHT.includes(row.status)) return null;

  const button = (
    <Button
      size="icon-sm"
      variant="ghost"
      className="text-muted-foreground hover:text-foreground"
      disabled={pending || !row.available}
      aria-label={row.status === "failed" ? "Retry transcription" : "Transcribe again"}
      onClick={(e) => {
        e.stopPropagation(); // the row itself opens the transcript
        setPending(true);
        api.retryJob(row.id).finally(() => {
          setPending(false);
          onRetried();
        });
      }}
    >
      <ArrowClockwise />
    </Button>
  );

  // a disabled button swallows hover, so the tooltip would never open on the unavailable path
  if (!row.available) return button;

  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent>{row.status === "failed" ? "Retry" : "Transcribe again"}</TooltipContent>
    </Tooltip>
  );
}

export function RecordingsList({ onOpen, onOpenSettings }: {
  onOpen: (id: number, ms?: number) => void;
  onOpenSettings: () => void;
}) {
  const [rows, setRows] = useState<RecordingSummary[]>([]);
  const [progress, setProgress] = useState<Record<number, { pct: number; eta: number | null }>>({});
  const [folders, setFolders] = useState<WatchFolder[]>([]);

  const load = useCallback(() => {
    api.listRecordings(undefined, { by: "recorded_at", dir: "desc" }).then(setRows);
  }, []);
  const loadFolders = useCallback(() => { api.listWatchFolders().then(setFolders); }, []);

  useEffect(() => { load(); loadFolders(); }, [load, loadFolders]);

  useEffect(() => {
    const offs = [
      // progress ticks are frequent — patch in place instead of refetching the list
      onJobProgress((p) => {
        setProgress((prev) => ({ ...prev, [p.recording_id]: { pct: p.pct, eta: p.eta_ms } }));
        setRows((prev) => prev.map((r) => (r.id === p.recording_id ? { ...r, status: p.stage } : r)));
      }),
      // terminal/new-row events are rare — a full refetch keeps duration/speaker_count/error correct
      onJobDone(load),
      onJobFailed(load),
      onRecordingDiscovered(load),
      // an overview landing is how a row gets its ai title
      onOverviewChanged(load),
    ];
    return () => offs.forEach((off) => off());
  }, [load]);

  const virtual = useVirtual({ count: rows.length, estimateSize: () => ROW_ESTIMATE, overscan: 8 });

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-baseline justify-between px-6 pt-8 pb-5">
        <h1 className="text-lg font-semibold tracking-tight">Recordings</h1>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">{rows.length} in library</span>
          <Button size="xs" variant="outline" onClick={onOpenSettings}>
            <FolderOpen />Folders
          </Button>
        </div>
      </header>

      <div ref={virtual.containerRef} className="min-h-0 flex-1 overflow-y-auto px-6 pb-8">
        {rows.length === 0 ? (
          <EmptyState hasFolders={folders.length > 0} onOpenSettings={onOpenSettings} />
        ) : (
          <div className="rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-28" />
                  <TableHead>Name</TableHead>
                  <TableHead className="w-28">Recorded</TableHead>
                  <TableHead className="w-20 text-right">Length</TableHead>
                  <TableHead className="w-16 text-right">Speakers</TableHead>
                  <TableHead className="w-36 text-right">Status</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                <tr aria-hidden="true" style={{ height: virtual.topPad }}><td colSpan={COLS} /></tr>
                {rows.slice(virtual.start, virtual.end).map((r, i) => {
                  const idx = virtual.start + i;
                  const live = IN_FLIGHT.includes(r.status);
                  return (
                    <TableRow
                      key={r.id}
                      ref={virtual.measureRef(idx)}
                      onClick={() => onOpen(r.id)}
                      className="group/row cursor-pointer"
                    >
                      <TableCell>
                        <Preview row={r} onOpenAt={(ms) => onOpen(r.id, ms)} />
                      </TableCell>
                      <TableCell className="max-w-0">
                        <div className="truncate font-medium">{r.title ?? r.filename}</div>
                        {r.title && (
                          <div className="truncate text-xs text-muted-foreground">{r.filename}</div>
                        )}
                        {!r.available && (
                          <div className="text-xs text-muted-foreground">source unavailable</div>
                        )}
                        {live && <Progress value={(progress[r.id]?.pct ?? 0) * 100} className="mt-2" />}
                        {r.status === "failed" && (() => {
                          const info = errorInfo(r.error);
                          return (
                            <div className="mt-1 flex items-center gap-2">
                              <span className="text-xs text-destructive">{info.message}</span>
                              {/* info.action === "retry" needs no button here — every row has one */}
                              {info.action === "settings" && (
                                <Button
                                  size="xs"
                                  variant="outline"
                                  onClick={(e) => { e.stopPropagation(); onOpenSettings(); }}
                                >
                                  <Gear />Fix in Settings
                                </Button>
                              )}
                            </div>
                          );
                        })()}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        <div>{dateLabel(r.recorded_at)}</div>
                        {/* several recordings a day is the norm; the date alone can't tell them apart */}
                        <div className="text-xs tabular-nums">{timeLabel(r.recorded_at)}</div>
                      </TableCell>
                      <TableCell className="text-right text-sm text-muted-foreground tabular-nums">
                        {durationLabel(r.duration_ms)}
                      </TableCell>
                      <TableCell className="text-right text-sm text-muted-foreground">
                        {r.speaker_count ? (
                          <span className="inline-flex items-center gap-1">
                            <Users />{r.speaker_count}
                          </span>
                        ) : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end"><StatusChip status={r.status} /></div>
                        {live && progress[r.id]?.eta != null && (
                          <div className="mt-1 text-xs text-muted-foreground tabular-nums">
                            {etaLabel(progress[r.id].eta)}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end"><RetryAction row={r} onRetried={load} /></div>
                      </TableCell>
                    </TableRow>
                  );
                })}
                <tr aria-hidden="true" style={{ height: virtual.bottomPad }}><td colSpan={COLS} /></tr>
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}

// folder add/remove/backfill now lives on the Settings screen (06-settings-and-shell.md) —
// this just tells the user where to go, depending on whether any folder is already watched.
function EmptyState({ hasFolders, onOpenSettings }: { hasFolders: boolean; onOpenSettings: () => void }) {
  return (
    <div className="flex flex-col items-center gap-4 py-20 text-center">
      <FolderOpen className="size-8 text-muted-foreground" />
      <div>
        <p className="text-sm font-medium">No recordings yet</p>
        <p className="text-sm text-muted-foreground">
          {hasFolders
            ? "Waiting for recordings to show up in a watched folder."
            : "Add a watch folder to start tracking meetings."}
        </p>
      </div>
      <Button size="sm" variant="outline" onClick={onOpenSettings}>
        <FolderOpen />{hasFolders ? "Manage folders" : "Add a folder"}
      </Button>
    </div>
  );
}
