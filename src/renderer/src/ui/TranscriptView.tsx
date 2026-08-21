import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft, ArrowSquareOut, CaretDown, CaretUp, Export, MagnifyingGlass, PencilSimple,
  Sparkle, VideoCameraSlash,
} from "@phosphor-icons/react";
import { api, os } from "@/ipc/client";
import type { ExportFormat, Person, RecordingDetail, Segment, Speaker } from "@/ipc/types";
import { hms } from "@/lib/format";
import { canPlayContainer } from "@/lib/media";
import { useVirtual } from "@/lib/virtual";
import { VideoPlayer } from "@/ui/VideoPlayer";
import { OverviewPanel } from "@/ui/Overview";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

type Item =
  | { kind: "header"; blockIdx: number; sid: number | null }
  | { kind: "segment"; blockIdx: number; seg: Segment };

const HEADER_ESTIMATE = 32;
const SEGMENT_ESTIMATE = 34;

export function TranscriptView({ id, onBack, initialMs = 0, initialTab = "transcript", onOpenSettings }: {
  id: number; onBack: () => void; initialMs?: number;
  initialTab?: "transcript" | "overview";
  onOpenSettings: () => void;
}) {
  const [detail, setDetail] = useState<RecordingDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [speakers, setSpeakers] = useState<Speaker[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [currentMs, setCurrentMs] = useState(initialMs);
  const [videoFailed, setVideoFailed] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("txt");
  const [exporting, setExporting] = useState(false);
  const [tab, setTab] = useState<string>(initialTab);
  const userScrolling = useRef(false);
  const scrollTimer = useRef(0);

  useEffect(() => {
    let stale = false;
    setDetail(null);
    setLoadError(null);
    setVideoFailed(false);
    setOpenError(null);
    api.getRecording(id).then(
      (d) => { if (!stale) { setDetail(d); setSpeakers(d.speakers); } },
      // without this the rejection is swallowed and the screen sits on "Loading…" forever
      (e) => { if (!stale) setLoadError(String(e)); },
    );
    setCurrentMs(initialMs);
    return () => { stale = true; };
  }, [id, initialMs, reloadKey]);

  // the names already known to the app, offered as completions so one voice gets one spelling
  useEffect(() => { api.listPeople().then(setPeople, () => {}); }, []);

  const blocks = useMemo(() => {
    const list: { sid: number | null; segs: Segment[] }[] = [];
    for (const seg of detail?.segments ?? []) {
      const last = list[list.length - 1];
      if (last && last.sid === seg.speaker_id) last.segs.push(seg);
      else list.push({ sid: seg.speaker_id, segs: [seg] });
    }
    return list;
  }, [detail]);

  const items = useMemo(() => {
    const list: Item[] = [];
    blocks.forEach((b, blockIdx) => {
      list.push({ kind: "header", blockIdx, sid: b.sid });
      for (const seg of b.segs) list.push({ kind: "segment", blockIdx, seg });
    });
    return list;
  }, [blocks]);

  const segIndexById = useMemo(() => {
    const m = new Map<number, number>();
    items.forEach((it, idx) => { if (it.kind === "segment") m.set(it.seg.id, idx); });
    return m;
  }, [items]);

  const estimateSize = useCallback(
    (i: number) => (items[i]?.kind === "header" ? HEADER_ESTIMATE : SEGMENT_ESTIMATE),
    [items],
  );
  const virtual = useVirtual({ count: items.length, estimateSize, overscan: 12, resetKey: id });

  const activeId = useMemo(() => {
    if (!detail) return null;
    return detail.segments.find((x) => currentMs >= x.start_ms && currentMs < x.end_ms)?.id ?? null;
  }, [detail, currentMs]);

  useEffect(() => {
    if (activeId == null || userScrolling.current) return;
    const idx = segIndexById.get(activeId);
    if (idx != null) virtual.scrollToIndex(idx, "center");
    // scrollToIndex/virtual are recreated every render; only re-run on the segment actually changing
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, segIndexById]);

  const q = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q) return [] as number[];
    return (detail?.segments ?? []).filter((s) => s.text.toLowerCase().includes(q)).map((s) => s.id);
  }, [detail, q]);

  useEffect(() => setMatchIndex(0), [q]);

  function jumpMatch(delta: number) {
    if (!matches.length) return;
    const next = (matchIndex + delta + matches.length) % matches.length;
    setMatchIndex(next);
    const idx = segIndexById.get(matches[next]);
    if (idx != null) virtual.scrollToIndex(idx, "center");
  }

  function markUserScroll() {
    userScrolling.current = true;
    clearTimeout(scrollTimer.current);
    scrollTimer.current = window.setTimeout(() => (userScrolling.current = false), 1500);
  }

  function nameFor(sid: number | null): string {
    if (sid == null) return "";
    const s = speakers.find((x) => x.id === sid);
    return s?.display_name || s?.label || "";
  }

  async function rename(sid: number, name: string) {
    await api.renameSpeaker(sid, name);
    // the name is now a person, so re-read: a fresh one has to show up in the completions
    const [fresh, known] = await Promise.all([api.getRecording(id), api.listPeople()]);
    setSpeakers(fresh.speakers);
    setPeople(known);
  }

  async function doExport() {
    if (!detail) return;
    const stem = detail.recording.filename.replace(/\.[^.]+$/, "");
    const dest = await os.saveFile(`${stem}.${exportFormat}`, [
      { name: exportFormat.toUpperCase(), extensions: [exportFormat] },
    ]);
    if (!dest) return;
    setExporting(true);
    try { await api.exportTranscript(id, exportFormat, dest); }
    finally { setExporting(false); }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft />Library
        </Button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {detail?.recording.filename ?? "Loading…"}
        </span>
        <div className="relative w-56">
          <MagnifyingGlass className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") jumpMatch(e.shiftKey ? -1 : 1);
            }}
            placeholder="Find in transcript"
            className="h-8 pl-7"
          />
        </div>
        {q && (
          <div className="flex items-center gap-0.5 text-xs text-muted-foreground">
            <span className="tabular-nums">{matches.length ? `${matchIndex + 1}/${matches.length}` : "0/0"}</span>
            <Button size="icon-xs" variant="ghost" onClick={() => jumpMatch(-1)}><CaretUp /></Button>
            <Button size="icon-xs" variant="ghost" onClick={() => jumpMatch(1)}><CaretDown /></Button>
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <select
            value={exportFormat}
            onChange={(e) => setExportFormat(e.target.value as ExportFormat)}
            className="h-8 rounded-lg border bg-transparent px-1.5 text-xs"
          >
            <option value="txt">TXT</option>
            <option value="json">JSON</option>
            <option value="srt">SRT</option>
            <option value="vtt">VTT</option>
          </select>
          <Button size="sm" variant="outline" disabled={!detail || exporting} onClick={doExport}>
            <Export />Export
          </Button>
        </div>
      </header>

      {loadError ? (
        <div className="flex flex-col items-start gap-3 p-8 text-sm">
          <p className="font-medium text-destructive">Couldn’t load this recording.</p>
          <p className="text-muted-foreground">{loadError}</p>
          <Button size="sm" variant="outline" onClick={() => setReloadKey((k) => k + 1)}>
            Try again
          </Button>
        </div>
      ) : !detail ? (
        <div className="p-8 text-sm text-muted-foreground">Loading…</div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] gap-4 p-4">
          <div className="flex flex-col gap-3">
            {detail.recording.available && !videoFailed
              && canPlayContainer(detail.recording.path) ? (
              <VideoPlayer
                recordingId={detail.recording.id}
                currentMs={currentMs}
                onTimeUpdate={setCurrentMs}
                onError={() => setVideoFailed(true)}
              />
            ) : (
              <Card className="flex aspect-video items-center justify-center border-dashed">
                <CardContent className="flex flex-col items-center gap-2 text-center text-sm text-muted-foreground">
                  <VideoCameraSlash className="size-6" />
                  {!detail.recording.available
                    ? <>Recording unavailable.</>
                    : <>No codec on this system for this file.</>}
                  <br />Transcript stays searchable.
                  {detail.recording.available && (
                    <Button
                      size="xs"
                      variant="outline"
                      className="mt-1"
                      onClick={() => {
                        setOpenError(null);
                        api.openInDefaultPlayer(id).catch((e) => setOpenError(String(e)));
                      }}
                    >
                      <ArrowSquareOut />Open in your media player
                    </Button>
                  )}
                  {openError && <span className="text-xs text-destructive">{openError}</span>}
                </CardContent>
              </Card>
            )}
            <Card>
              <CardContent className="text-sm text-muted-foreground">
                {speakers.length
                  ? <>Speakers: {speakers.map((s) => s.display_name || s.label).join(", ")}</>
                  : "No speakers yet."}
              </CardContent>
            </Card>
          </div>

          <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-col gap-2">
            <TabsList variant="line">
              <TabsTrigger value="transcript">Transcript</TabsTrigger>
              <TabsTrigger value="overview"><Sparkle />Overview</TabsTrigger>
            </TabsList>

            <TabsContent value="transcript" className="min-h-0" keepMounted>
              <Card className="h-full min-h-0 overflow-hidden p-0">
            <div
              ref={virtual.containerRef}
              onWheel={markUserScroll}
              onTouchMove={markUserScroll}
              className="h-full overflow-y-auto"
            >
              <div style={{ height: virtual.topPad }} />
              {items.slice(virtual.start, virtual.end).map((it, i) => {
                const idx = virtual.start + i;
                if (it.kind === "header") {
                  return (
                    <div key={`h-${it.blockIdx}`} ref={virtual.measureRef(idx)} className="px-4 pt-4 pb-1">
                      <SpeakerName
                        sid={it.sid}
                        name={nameFor(it.sid)}
                        known={people}
                        onRename={rename}
                      />
                    </div>
                  );
                }
                const seg = it.seg;
                const active = seg.id === activeId;
                const isMatch = q !== "" && seg.text.toLowerCase().includes(q);
                const isCurrentMatch = matches[matchIndex] === seg.id;
                return (
                  <p
                    key={seg.id}
                    ref={virtual.measureRef(idx)}
                    data-seg={seg.id}
                    onClick={() => setCurrentMs(seg.start_ms)}
                    className={cn(
                      "mx-4 cursor-pointer rounded-md px-2 py-1 text-sm leading-relaxed transition-colors",
                      active ? "bg-primary/10 text-foreground" : "hover:bg-muted",
                      isMatch && "ring-1 ring-primary/40",
                      isCurrentMatch && "ring-2 ring-primary",
                    )}
                  >
                    <span className="mr-2 font-mono text-[11px] text-muted-foreground tabular-nums">
                      {hms(seg.start_ms)}
                    </span>
                    {seg.speaker_id == null
                      ? <span className="text-muted-foreground italic">{seg.text}</span>
                      : seg.text}
                  </p>
                );
              })}
              <div style={{ height: virtual.bottomPad }} />
            </div>
              </Card>
            </TabsContent>

            <TabsContent value="overview" className="min-h-0">
              <Card className="h-full min-h-0 overflow-hidden p-0">
                <OverviewPanel
                  recordingId={id}
                  segments={detail.segments}
                  speakers={speakers}
                  ready={detail.recording.status === "done"}
                  onSeek={setCurrentMs}
                  onOpenSettings={onOpenSettings}
                />
              </Card>
            </TabsContent>
          </Tabs>
        </div>
      )}
    </div>
  );
}

function SpeakerName({ sid, name, known, onRename }: {
  sid: number | null; name: string; known: Person[]; onRename: (sid: number, name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);

  if (sid == null)
    return <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Unattributed</span>;

  if (editing)
    return (
      <>
        <datalist id="known-people">
          {known.map((p) => <option key={p.id} value={p.name} />)}
        </datalist>
        <Input autoFocus list="known-people" value={draft} onChange={(e) => setDraft(e.target.value)}
          onBlur={() => { setEditing(false); if (draft !== name) onRename(sid, draft); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") { setDraft(name); setEditing(false); }
          }}
          className="h-6 w-40 text-xs font-semibold tracking-wide uppercase" />
      </>
    );

  return (
    <Button variant="link" size="xs"
      className="h-auto gap-1 p-0 text-xs font-semibold tracking-wide uppercase"
      onClick={() => setEditing(true)}>
      {name}<PencilSimple className="text-muted-foreground" />
    </Button>
  );
}
