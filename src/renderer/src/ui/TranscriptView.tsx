import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft, ArrowSquareOut, CaretDown, CaretUp, Check, Copy, DotsThree, Export, MagnifyingGlass,
  PencilSimple, Sparkle, UsersThree, VideoCameraSlash,
} from "@phosphor-icons/react";
import { api, onJobDone, onJobFailed, onTranscriptChanged, os } from "@/ipc/client";
import type { ExportFormat, Person, RecordingDetail, Segment, Speaker } from "@/ipc/types";
import { hms } from "@/lib/format";
import { canPlayContainer } from "@/lib/media";
import { speakerPalette, type SpeakerPalette } from "@/lib/speakerColor";
import { useVirtual } from "@/lib/virtual";
import { SpeakerDot } from "@/ui/SpeakerDot";
import { VideoPlayer } from "@/ui/VideoPlayer";
import { EditableTitle } from "@/ui/EditableTitle";
import { OverviewPanel } from "@/ui/Overview";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [tab, setTab] = useState<string>(initialTab);
  const [rediarizing, setRediarizing] = useState(false);
  const [speakerError, setSpeakerError] = useState<string | null>(null);
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

  const shownTitle = detail?.recording.title ?? null;
  const playable = !!detail && detail.recording.available && !videoFailed
    && canPlayContainer(detail.recording.path);
  // the player is 16:9 unless the file is audio-only; the fallback card always is
  const boxed = !playable || (detail?.recording.has_video ?? false);
  useEffect(() => {
    if (!detail) return;
    document.title = `${shownTitle ?? detail.recording.filename} — unottr`;
    return () => { document.title = "unottr"; };
  }, [detail, shownTitle]);

  const renameRecording = useCallback(async (title: string) => {
    await api.setTitle(id, title);
    // an empty title falls back to the ai one, which only a reload knows
    const d = await api.getRecording(id);
    setDetail((cur) => (cur ? { ...cur, recording: d.recording } : cur));
  }, [id]);

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

  const palette = useMemo(() => speakerPalette(speakers), [speakers]);

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

  /** Re-read without blanking the view: a speaker fix must not flash the whole screen. */
  const refresh = useCallback(async () => {
    const d = await api.getRecording(id);
    setDetail(d);
    setSpeakers(d.speakers);
  }, [id]);

  useEffect(() => {
    const offs = [
      onJobDone((p) => { if (p.recording_id === id) { setRediarizing(false); void refresh(); } }),
      onJobFailed((p) => {
        if (p.recording_id !== id) return;
        setRediarizing(false);
        setSpeakerError(`Re-running speakers failed (${p.error}). The old speakers are unchanged.`);
      }),
      onTranscriptChanged((p) => { if (p.recording_id === id) void refresh(); }),
    ];
    return () => { for (const off of offs) off(); };
  }, [id, refresh]);

  const fix = useCallback(async (act: () => Promise<unknown>) => {
    setSpeakerError(null);
    try {
      await act();
      await refresh();
    } catch (e) {
      setSpeakerError(String(e));
    }
  }, [refresh]);

  async function startRediarize(count: number | null) {
    setSpeakerError(null);
    setRediarizing(true);
    try {
      await api.rediarize(id, count);
    } catch (e) {
      setRediarizing(false);
      setSpeakerError(String(e));
    }
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

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(t);
  }, [copied]);

  async function doCopy() {
    if (!detail) return;
    setCopyError(null);
    try {
      await api.copyTranscript(id, exportFormat);
      setCopied(true);
    } catch (e) {
      setCopyError(String(e));
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2.5 sm:gap-x-3 sm:px-4 sm:py-3">
        <Button variant="ghost" size="sm" onClick={onBack} aria-label="Back to library">
          <ArrowLeft /><span className="hidden sm:inline">Library</span>
        </Button>
        <div className="min-w-0 flex-1 text-sm font-medium">
          {detail ? (
            <EditableTitle value={shownTitle ?? detail.recording.filename} initial={detail.recording.title ?? ""}
              onCommit={renameRecording} inputClassName="w-full max-w-md text-sm font-medium" />
          ) : "Loading…"}
        </div>
        {/* below md the field takes a row of its own rather than squeezing title + actions */}
        <div className="order-last flex w-full items-center gap-0.5 md:order-none md:w-auto">
          <div className="relative min-w-0 flex-1 md:w-40 md:flex-none lg:w-56">
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
            <div className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground">
              <span className="tabular-nums">{matches.length ? `${matchIndex + 1}/${matches.length}` : "0/0"}</span>
              <Button size="icon-xs" variant="ghost" onClick={() => jumpMatch(-1)}><CaretUp /></Button>
              <Button size="icon-xs" variant="ghost" onClick={() => jumpMatch(1)}><CaretDown /></Button>
            </div>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5 md:ml-0">
          <Select value={exportFormat} onValueChange={(v) => setExportFormat(v as ExportFormat)}>
            <SelectTrigger className="text-xs" aria-label="Export format">
              <SelectValue>{(v) => String(v).toUpperCase()}</SelectValue>
            </SelectTrigger>
            {/* default centers the popup on the selected item -> a 4-char trigger gets a menu
                hanging off to its left */}
            <SelectContent align="start" alignItemWithTrigger={false} className="w-auto min-w-(--anchor-width)">
              {(["txt", "json", "srt", "vtt"] as const).map((f) => (
                <SelectItem key={f} value={f} className="text-xs">{f.toUpperCase()}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Copy transcript"
                  disabled={!detail}
                  onClick={doCopy}
                >
                  {copied ? <Check /> : <Copy />}
                </Button>
              }
            />
            <TooltipContent>
              {copyError ?? (copied ? "Copied" : `Copy ${exportFormat.toUpperCase()} to clipboard`)}
            </TooltipContent>
          </Tooltip>
          <Button size="sm" variant="outline" aria-label="Export" disabled={!detail || exporting} onClick={doExport}>
            <Export /><span className="hidden lg:inline">Export</span>
          </Button>
          <Menu
            align="end"
            trigger={<Button size="icon-sm" variant="ghost" aria-label="More"><DotsThree /></Button>}
          >
            {(close) => (
              <RediarizeForm
                current={speakers.length}
                disabled={!detail || detail.recording.status !== "done" || rediarizing}
                onSubmit={(n) => { close(); void startRediarize(n); }}
              />
            )}
          </Menu>
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
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-4 lg:p-4">
          <div className={cn(
            "flex shrink-0 flex-col gap-3 lg:min-h-0",
            // stacked, a full-width 16:9 box would eat the transcript — cap it by height instead
            boxed && "mx-auto w-full max-w-[max(18rem,calc((100dvh_-_26rem)*16/9))] lg:mx-0 lg:max-w-none",
          )}>
            {playable ? (
              <VideoPlayer
                recordingId={detail.recording.id}
                durationMs={detail.recording.duration_ms}
                hasVideo={detail.recording.has_video}
                segments={detail.segments}
                speakers={speakers}
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
            {/* stacked, a long speaker list would push the transcript out of the viewport */}
            <Card className="max-h-28 overflow-y-auto lg:max-h-none">
              <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
                <SpeakerStrip
                  speakers={speakers}
                  palette={palette}
                  busy={rediarizing}
                  onMerge={(fromId, intoId) => fix(() => api.mergeSpeakers(id, fromId, intoId))}
                />
                {speakerError && <span className="text-xs text-destructive">{speakerError}</span>}
              </CardContent>
            </Card>
          </div>

          <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-2">
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
                    <div key={`h-${it.blockIdx}`} ref={virtual.measureRef(idx)} className="px-3 pt-4 pb-1 sm:px-4">
                      <SpeakerName
                        sid={it.sid}
                        name={nameFor(it.sid)}
                        color={palette.ui(it.sid)}
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
                  <div
                    key={seg.id}
                    ref={virtual.measureRef(idx)}
                    data-seg={seg.id}
                    onClick={() => setCurrentMs(seg.start_ms)}
                    className={cn(
                      "group relative mx-3 cursor-pointer rounded-md py-1 pr-8 pl-2 text-sm leading-relaxed transition-colors sm:mx-4",
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
                    <ReassignMenu
                      speakers={speakers}
                      palette={palette}
                      current={seg.speaker_id}
                      onPick={(sid) => fix(() => api.setSegmentSpeaker(id, seg.id, sid))}
                      onNew={() => fix(() => api.segmentNewSpeaker(id, seg.id))}
                    />
                  </div>
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

function SpeakerName({ sid, name, color, known, onRename }: {
  sid: number | null; name: string; color: string; known: Person[];
  onRename: (sid: number, name: string) => void;
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
      className="h-auto gap-1.5 p-0 text-xs font-semibold tracking-wide uppercase"
      style={{ color }}
      onClick={() => setEditing(true)}>
      <SpeakerDot color={color} className="size-1.5" />
      {name}<PencilSimple className="text-muted-foreground" />
    </Button>
  );
}


/**
 * A hand-rolled popover — there is no dropdown-menu primitive in this project. `children` is
 * given a `close` so an item can dismiss the panel it lives in.
 *
 * The panel is portalled to the body and positioned fixed: `Card` sets `overflow-hidden`, and
 * the transcript list is its own scroll box, so an in-flow absolute panel gets sliced off at
 * the nearest edge. Fixed also keeps it out of the virtualiser's row measurements.
 */
function Menu({ trigger, children, align = "start", className }: {
  trigger: ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "start" | "end";
  className?: string;
}) {
  const [at, setAt] = useState<{ top: number; left?: number; right?: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const open = at !== null;

  const place = useCallback(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setAt({
      top: r.bottom + 4,
      ...(align === "end" ? { right: window.innerWidth - r.right } : { left: r.left }),
    });
  }, [align]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !panel.current?.contains(t)) setAt(null);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setAt(null); };
    // fixed coords go stale the moment anything scrolls, so close rather than chase it
    const bail = () => setAt(null);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    document.addEventListener("scroll", bail, true);
    window.addEventListener("resize", bail);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
      document.removeEventListener("scroll", bail, true);
      window.removeEventListener("resize", bail);
    };
  }, [open]);

  return (
    <div ref={ref} className={cn("relative", className)}>
      <span onClick={(e) => { e.stopPropagation(); if (open) setAt(null); else place(); }}>{trigger}</span>
      {at && createPortal(
        <div
          ref={panel}
          onClick={(e) => e.stopPropagation()}
          style={{ top: at.top, left: at.left, right: at.right }}
          className="fixed z-50 max-h-[min(20rem,60vh)] min-w-44 overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {children(() => setAt(null))}
        </div>,
        document.body,
      )}
    </div>
  );
}

const ITEM = "w-full justify-start rounded-md px-2 py-1 text-left text-xs font-normal";

function SpeakerStrip({ speakers, palette, busy, onMerge }: {
  speakers: Speaker[];
  palette: SpeakerPalette;
  busy: boolean;
  onMerge: (fromId: number, intoId: number) => void;
}) {
  const [pending, setPending] = useState<{ from: Speaker; into: Speaker; count: number } | null>(null);
  const label = (s: Speaker) => s.display_name || s.label;

  if (busy) return <span className="text-xs">Re-running speakers…</span>;
  if (!speakers.length) return <span>No speakers yet.</span>;

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        <UsersThree className="size-4" />
        {speakers.map((s) => (
          <Menu
            key={s.id}
            trigger={
              <Button size="xs" variant="secondary" className="gap-1.5 font-normal">
                <SpeakerDot color={palette.ui(s.id)} />
                {label(s)}<CaretDown className="text-muted-foreground" />
              </Button>
            }
          >
            {(close) =>
              speakers.length < 2 ? (
                <p className="px-2 py-1 text-xs text-muted-foreground">Nobody to merge with.</p>
              ) : (
                <>
                  <p className="px-2 py-1 text-[11px] tracking-wide text-muted-foreground uppercase">
                    Merge into…
                  </p>
                  {speakers.filter((o) => o.id !== s.id).map((other) => (
                    <Button
                      key={other.id}
                      variant="ghost"
                      size="xs"
                      className={cn(ITEM, "gap-1.5")}
                      onClick={() => {
                        close();
                        api.speakerSegmentCount(s.id).then(
                          (count) => setPending({ from: s, into: other, count }),
                          () => setPending({ from: s, into: other, count: 0 }),
                        );
                      }}
                    >
                      <SpeakerDot color={palette.ui(other.id)} />{label(other)}
                    </Button>
                  ))}
                </>
              )
            }
          </Menu>
        ))}
      </div>

      {pending && (
        <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-2 py-1.5 text-xs">
          <span className="flex-1 text-foreground">
            Merge {label(pending.from)} into {label(pending.into)}? {pending.count}{" "}
            {pending.count === 1 ? "segment" : "segments"}.
          </span>
          <Button size="xs" variant="outline" onClick={() => setPending(null)}>Cancel</Button>
          <Button
            size="xs"
            onClick={() => { onMerge(pending.from.id, pending.into.id); setPending(null); }}
          >
            Merge
          </Button>
        </div>
      )}
    </>
  );
}

/** The per-segment speaker fix. Hidden until the row is hovered, so it costs no reading space. */
function ReassignMenu({ speakers, palette, current, onPick, onNew }: {
  speakers: Speaker[];
  palette: SpeakerPalette;
  current: number | null;
  onPick: (sid: number | null) => void;
  onNew: () => void;
}) {
  return (
    <Menu
      align="end"
      className="absolute top-0.5 right-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
      trigger={
        <Button size="icon-xs" variant="ghost" aria-label="Change speaker">
          <PencilSimple />
        </Button>
      }
    >
      {(close) => (
        <>
          <p className="px-2 py-1 text-[11px] tracking-wide text-muted-foreground uppercase">
            Said by
          </p>
          {speakers.map((s) => (
            <Button
              key={s.id}
              variant="ghost"
              size="xs"
              className={cn(ITEM, "gap-1.5", s.id === current && "bg-muted")}
              onClick={() => { close(); if (s.id !== current) onPick(s.id); }}
            >
              <SpeakerDot color={palette.ui(s.id)} />{s.display_name || s.label}
            </Button>
          ))}
          <Button variant="ghost" size="xs" className={ITEM} onClick={() => { close(); onNew(); }}>
            New speaker
          </Button>
          {current !== null && (
            <Button variant="ghost" size="xs" className={ITEM} onClick={() => { close(); onPick(null); }}>
              Unattributed
            </Button>
          )}
        </>
      )}
    </Menu>
  );
}

/** "How many people spoke?" — the worker's fixed-k, exposed (decision #50). */
function RediarizeForm({ current, disabled, onSubmit }: {
  current: number;
  disabled: boolean;
  onSubmit: (count: number | null) => void;
}) {
  const [count, setCount] = useState(String(Math.max(1, current)));
  const n = Number.parseInt(count, 10);
  const valid = Number.isFinite(n) && n >= 1 && n <= 20;

  if (disabled)
    return (
      <p className="w-60 px-2 py-1 text-xs text-muted-foreground">
        Re-running speakers needs a finished recording.
      </p>
    );

  return (
    <div className="flex w-64 flex-col gap-2 p-1">
      <p className="text-xs font-medium">Re-run speakers</p>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        How many people spoke?
        <Input
          autoFocus
          value={count}
          onChange={(e) => setCount(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && valid) onSubmit(n); }}
          className="h-7 w-14 text-xs"
        />
      </label>
      <p className="text-[11px] leading-snug text-muted-foreground">
        The transcript text is untouched. Names you typed here that are not a known person are
        lost; voices the app recognises come back named.
      </p>
      <div className="flex justify-end">
        <Button size="xs" disabled={!valid} onClick={() => onSubmit(n)}>Re-run</Button>
      </div>
    </div>
  );
}
