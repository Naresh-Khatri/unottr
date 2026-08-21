import { memo, useEffect, useRef, useState } from "react";
import { frameUrl, PREVIEW_COUNT, previewUrl } from "@/ipc/client";
import { hms } from "@/lib/format";
import type { SpeakerBand } from "@/lib/playback";
import { cn } from "@/lib/utils";

const BUBBLE_W = 176;

/** Preview i sits at (i+1)/(PREVIEW_COUNT+1) of the file — mirrors extractThumbnails' spacing. */
const nearestPreview = (frac: number): number =>
  Math.min(PREVIEW_COUNT - 1, Math.max(0, Math.round(frac * (PREVIEW_COUNT + 1)) - 1));

/** Frames are cached per exact ms, so snap to a second — otherwise every pixel spawns an ffmpeg. */
const snapMs = (ms: number): number => Math.round(ms / 1000) * 1000;

/** Distinct enough to read as "a different voice" without inventing colour in a greyscale ui. */
const BAND_ALPHA = [0.95, 0.66, 0.46, 0.34, 0.26];

const bandAlpha = (sid: number | null, speakerIds: number[]): number => {
  if (sid == null) return 0.14;
  const i = speakerIds.indexOf(sid);
  return BAND_ALPHA[(i === -1 ? 0 : i) % BAND_ALPHA.length];
};

/**
 * The scrub bar: buffered range, speaker map, and a hover preview that shows one of the frames
 * the ingest job already extracted, upgraded to the exact frame once the pointer settles.
 */
export function PlayerTimeline({
  recordingId, durationMs, currentMs, bufferedMs, hasVideo, bands, speakerIds, nameFor,
  onSeek, onScrubbing,
}: {
  recordingId: number;
  durationMs: number;
  currentMs: number;
  bufferedMs: number;
  hasVideo: boolean;
  bands: SpeakerBand[];
  speakerIds: number[];
  nameFor: (sid: number | null) => string;
  onSeek: (ms: number) => void;
  onScrubbing: (on: boolean) => void;
}) {
  const rail = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ frac: number; x: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [exactMs, setExactMs] = useState<number | null>(null);
  const [loadedMs, setLoadedMs] = useState<number | null>(null);
  const warmed = useRef(false);
  const pendingSeek = useRef<number | null>(null);
  const raf = useRef(0);

  const hoverMs = hover ? hover.frac * durationMs : 0;
  const played = durationMs > 0 ? Math.min(1, currentMs / durationMs) : 0;

  // the exact frame is worth one ffmpeg only once the pointer has settled
  useEffect(() => {
    if (!hover || !hasVideo || durationMs <= 0) return;
    const ms = snapMs(hover.frac * durationMs);
    const t = setTimeout(() => setExactMs(ms), 160);
    return () => clearTimeout(t);
  }, [hover, hasVideo, durationMs]);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  // rAF-throttled: a drag fires pointermove far faster than chromium can service a seek
  function seekThrottled(ms: number) {
    pendingSeek.current = ms;
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      if (pendingSeek.current != null) onSeek(pendingSeek.current);
    });
  }

  function at(clientX: number): { frac: number; x: number; width: number } {
    const box = rail.current?.getBoundingClientRect();
    if (!box || box.width === 0) return { frac: 0, x: 0, width: 0 };
    const x = Math.min(box.width, Math.max(0, clientX - box.left));
    return { frac: x / box.width, x, width: box.width };
  }

  const showExact = exactMs != null && loadedMs === exactMs && Math.abs(exactMs - hoverMs) < 1200;
  // the bubble follows the pointer but never hangs off either end of the rail
  const bubbleX = hover
    ? Math.min(Math.max(hover.x, BUBBLE_W / 2), Math.max(BUBBLE_W / 2, hover.width - BUBBLE_W / 2))
    : 0;

  return (
    <div
      ref={rail}
      // a 4px bar is not a pointer target; the padding is the hit area
      className="group/rail relative cursor-pointer touch-none py-2"
      onPointerEnter={() => {
        if (warmed.current || !hasVideo) return;
        warmed.current = true;
        // scrubbing has to feel instant, so pull the coarse frames into the cache on first hover
        for (let i = 0; i < PREVIEW_COUNT; i++) new Image().src = previewUrl(recordingId, i);
      }}
      onPointerMove={(e) => {
        const p = at(e.clientX);
        setHover(p);
        if (dragging) seekThrottled(p.frac * durationMs);
      }}
      onPointerLeave={() => { if (!dragging) setHover(null); }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
        onScrubbing(true);
        const p = at(e.clientX);
        setHover(p);
        onSeek(p.frac * durationMs);
      }}
      onPointerUp={(e) => {
        if (!dragging) return;
        e.currentTarget.releasePointerCapture(e.pointerId);
        setDragging(false);
        setHover(null);
        onScrubbing(false);
        onSeek(at(e.clientX).frac * durationMs);
      }}
      // a cancelled drag (context menu, window blur) would otherwise leave the parent's
      // currentMs sync suppressed for good
      onPointerCancel={() => { setDragging(false); setHover(null); onScrubbing(false); }}
    >
      {/* speaker map — who holds the floor, at a glance */}
      <div className="relative mb-[3px] h-[3px] w-full overflow-hidden rounded-full bg-white/10">
        <Bands bands={bands} durationMs={durationMs} speakerIds={speakerIds} />
        {/* everything ahead of the playhead reads as "not yet heard" */}
        <span className="absolute inset-y-0 right-0 bg-black/55" style={{ left: `${played * 100}%` }} />
      </div>

      <div className="relative">
        <div
          className={cn(
            "relative w-full overflow-hidden rounded-full bg-white/25 transition-[height] duration-150",
            dragging ? "h-[6px]" : "h-[4px] group-hover/rail:h-[6px]",
          )}
        >
          <span
            className="absolute inset-y-0 left-0 bg-white/30"
            style={{ width: `${durationMs > 0 ? Math.min(100, (bufferedMs / durationMs) * 100) : 0}%` }}
          />
          {hover && (
            <span className="absolute inset-y-0 left-0 bg-white/40" style={{ width: `${hover.frac * 100}%` }} />
          )}
          <span className="absolute inset-y-0 left-0 bg-white" style={{ width: `${played * 100}%` }} />
        </div>
        <span
          className={cn(
            "pointer-events-none absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow transition-[scale]",
            dragging ? "scale-110" : "scale-0 group-hover/rail:scale-100",
          )}
          style={{ left: `${played * 100}%` }}
        />
      </div>

      {hover && durationMs > 0 && (
        <div
          className="pointer-events-none absolute bottom-full mb-2 flex -translate-x-1/2 flex-col items-center gap-1"
          style={{ left: bubbleX }}
        >
          {hasVideo && (
            <div
              className="relative overflow-hidden rounded-md border border-white/20 bg-black shadow-lg"
              style={{ width: BUBBLE_W, aspectRatio: "16 / 9" }}
            >
              {/* the coarse frame answers instantly and holds until the exact one is extracted */}
              <img
                src={previewUrl(recordingId, nearestPreview(hover.frac))}
                alt=""
                draggable={false}
                className="size-full scale-[1.03] object-cover blur-[1px]"
              />
              {exactMs != null && (
                <img
                  src={frameUrl(recordingId, exactMs)}
                  alt=""
                  draggable={false}
                  onLoad={() => setLoadedMs(exactMs)}
                  className={cn(
                    "absolute inset-0 size-full object-cover transition-opacity duration-150",
                    showExact ? "opacity-100" : "opacity-0",
                  )}
                />
              )}
            </div>
          )}
          <span className="flex max-w-60 items-center gap-1.5 rounded-md bg-black/85 px-1.5 py-0.5 text-[11px] text-white shadow">
            <span className="font-mono tabular-nums">{hms(hoverMs)}</span>
            <SpeakerAt bands={bands} ms={hoverMs} nameFor={nameFor} />
          </span>
        </div>
      )}
    </div>
  );
}

/** Hundreds of spans that only change when the transcript does — kept out of the timeupdate path. */
const Bands = memo(function Bands({ bands, durationMs, speakerIds }: {
  bands: SpeakerBand[]; durationMs: number; speakerIds: number[];
}) {
  if (durationMs <= 0) return null;
  return (
    <>
      {bands.map((b, i) => (
        <span
          key={i}
          className="absolute inset-y-0"
          style={{
            left: `${(b.start_ms / durationMs) * 100}%`,
            width: `${Math.max(0.2, ((b.end_ms - b.start_ms) / durationMs) * 100)}%`,
            background: `oklch(1 0 0 / ${bandAlpha(b.sid, speakerIds)})`,
          }}
        />
      ))}
    </>
  );
});

function SpeakerAt({ bands, ms, nameFor }: {
  bands: SpeakerBand[]; ms: number; nameFor: (sid: number | null) => string;
}) {
  const band = bands.find((b) => ms >= b.start_ms && ms < b.end_ms);
  const name = band ? nameFor(band.sid) : "";
  if (!name) return null;
  return <span className="truncate text-white/70">{name}</span>;
}
