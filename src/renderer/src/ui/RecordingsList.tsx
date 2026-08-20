import { useCallback, useEffect, useState } from "react";
import { ArrowClockwise, FolderOpen, Gear, Users } from "@phosphor-icons/react";
import { api, onJobDone, onJobFailed, onJobProgress, onRecordingDiscovered } from "@/ipc/client";
import type { RecordingSummary, WatchFolder } from "@/ipc/types";
import { IN_FLIGHT } from "@/ipc/types";
import { dateLabel, durationLabel } from "@/lib/format";
import { errorInfo } from "@/lib/errors";
import { useVirtual } from "@/lib/virtual";
import { StatusChip } from "@/ui/StatusChip";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

const ROW_ESTIMATE = 56; // measured hook corrects this once rows with progress/error mount
const COLS = 5;

export function RecordingsList({ onOpen, onOpenSettings }: {
  onOpen: (id: number) => void;
  onOpenSettings: () => void;
}) {
  const [rows, setRows] = useState<RecordingSummary[]>([]);
  const [progress, setProgress] = useState<Record<number, number>>({});
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
        setProgress((prev) => ({ ...prev, [p.recording_id]: p.pct }));
        setRows((prev) => prev.map((r) => (r.id === p.recording_id ? { ...r, status: p.stage } : r)));
      }),
      // terminal/new-row events are rare — a full refetch keeps duration/speaker_count/error correct
      onJobDone(load),
      onJobFailed(load),
      onRecordingDiscovered(load),
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
                  <TableHead>Name</TableHead>
                  <TableHead className="w-28">Recorded</TableHead>
                  <TableHead className="w-20 text-right">Length</TableHead>
                  <TableHead className="w-16 text-right">Speakers</TableHead>
                  <TableHead className="w-36 text-right">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <tr aria-hidden="true" style={{ height: virtual.topPad }}><td colSpan={COLS} /></tr>
                {rows.slice(virtual.start, virtual.end).map((r, i) => {
                  const idx = virtual.start + i;
                  const live = IN_FLIGHT.includes(r.status);
                  return (
                    <TableRow key={r.id} ref={virtual.measureRef(idx)} onClick={() => onOpen(r.id)} className="cursor-pointer">
                      <TableCell className="max-w-0">
                        <div className="truncate font-medium">{r.filename}</div>
                        {!r.available && (
                          <div className="text-xs text-muted-foreground">source unavailable</div>
                        )}
                        {live && <Progress value={(progress[r.id] ?? 0) * 100} className="mt-2" />}
                        {r.status === "failed" && (() => {
                          const info = errorInfo(r.error);
                          return (
                            <div className="mt-1 flex items-center gap-2">
                              <span className="text-xs text-destructive">{info.message}</span>
                              {info.action === "retry" && (
                                <Button
                                  size="xs"
                                  variant="outline"
                                  onClick={(e) => { e.stopPropagation(); api.retryJob(r.id).then(load); }}
                                >
                                  <ArrowClockwise />Retry
                                </Button>
                              )}
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
                        {dateLabel(r.recorded_at)}
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
