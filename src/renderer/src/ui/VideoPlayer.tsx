import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowClockwise, ArrowCounterClockwise, CornersIn, CornersOut, Pause, PictureInPicture, Play,
  SpeakerHigh, SpeakerLow, SpeakerSimpleX, SpinnerGap, Waveform, X,
} from "@phosphor-icons/react";
import { mediaUrl, thumbUrl } from "@/ipc/client";
import type { Segment, Speaker } from "@/ipc/types";
import { hms } from "@/lib/format";
import {
  clearPosition, loadPosition, loadPrefs, RATES, resumeOffer, savePosition, savePrefs,
  speakerBands, stepRate,
} from "@/lib/playback";
import { speakerPalette } from "@/lib/speakerColor";
import { PlayerTimeline } from "@/ui/PlayerTimeline";
import { cn } from "@/lib/utils";

// Bidirectional currentMs sync: segment clicks / find-jumps set currentMs -> we seek the
// element; playback drives currentMs the other way via timeupdate. The threshold stops our
// own timeupdate echo from re-triggering a seek every frame.
const SEEK_EPSILON_MS = 350;

const SKIP_MS = 10_000;
const ARROW_MS = 5_000;
const CHROME_HIDE_MS = 2200;
const POSITION_SAVE_MS = 5_000;
/** A band this short is a sub-pixel sliver on the ribbon and only costs a dom node. */
const MIN_BAND_MS = 250;

export function VideoPlayer({
  recordingId, durationMs, hasVideo, segments, speakers, currentMs, onTimeUpdate, onError,
}: {
  recordingId: number;
  durationMs: number | null;
  hasVideo: boolean;
  segments: Segment[];
  speakers: Speaker[];
  currentMs: number;
  onTimeUpdate: (ms: number) => void;
  onError: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const shell = useRef<HTMLDivElement>(null);

  const [prefs] = useState(loadPrefs);
  const [volume, setVolume] = useState(prefs.volume);
  const [muted, setMuted] = useState(prefs.muted);
  const [rate, setRate] = useState(prefs.rate);

  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [elDuration, setElDuration] = useState<number | null>(null);
  const [bufferedMs, setBufferedMs] = useState(0);
  const [chrome, setChrome] = useState(true);
  const [scrubbing, setScrubbing] = useState(false);
  const [rateOpen, setRateOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [countdown, setCountdown] = useState(false);
  const [flash, setFlash] = useState<{ text: string; back: boolean; n: number } | null>(null);

  // preload="none" means the element has no duration until the user asks for bytes, so the
  // probed one is what draws a real timeline before the first play
  const duration = elDuration ?? durationMs ?? 0;
  const durationRef = useRef(duration);
  durationRef.current = duration;
  const playingRef = useRef(false);
  const lastMs = useRef(currentMs);
  const savedAt = useRef(0);
  const overBar = useRef(false);
  const rateOpenRef = useRef(false);
  const hideTimer = useRef(0);
  const flashTimer = useRef(0);
  const flashN = useRef(0);

  const offerResume = (): number | null =>
    // opened at a moment already (a search hit, a cited bullet) -> that beats the saved one
    currentMs > 1500 ? null : resumeOffer(loadPosition(recordingId), durationMs);

  const [resume, setResume] = useState<number | null>(offerResume);
  const [seenId, setSeenId] = useState(recordingId);
  if (seenId !== recordingId) {
    setSeenId(recordingId);
    setResume(offerResume());
    setElDuration(null);
    setBufferedMs(0);
  }

  const palette = useMemo(() => speakerPalette(speakers), [speakers]);
  const bands = useMemo(
    () => speakerBands(segments).filter((b) => b.end_ms - b.start_ms >= MIN_BAND_MS),
    [segments],
  );
  const nameFor = useCallback(
    (sid: number | null): string => {
      if (sid == null) return "";
      const s = speakers.find((x) => x.id === sid);
      return s?.display_name || s?.label || "";
    },
    [speakers],
  );

  const seek = useCallback((ms: number) => {
    const el = video.current;
    if (!el) return;
    const d = durationRef.current;
    const target = Math.max(0, d > 0 ? Math.min(ms, d - 20) : ms);
    el.currentTime = target / 1000;
    lastMs.current = target;
    onTimeUpdate(target);
  }, [onTimeUpdate]);

  const togglePlay = useCallback(() => {
    const el = video.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => {});
    else el.pause();
  }, []);

  const showFlash = useCallback((text: string, back: boolean) => {
    flashN.current += 1;
    setFlash({ text, back, n: flashN.current });
    clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 700);
  }, []);

  const skip = useCallback((delta: number) => {
    const el = video.current;
    if (!el) return;
    seek(el.currentTime * 1000 + delta);
    showFlash(`${Math.abs(delta) / 1000}s`, delta < 0);
  }, [seek, showFlash]);

  const nudgeChrome = useCallback(() => {
    setChrome(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (playingRef.current && !overBar.current && !rateOpenRef.current) setChrome(false);
    }, CHROME_HIDE_MS);
  }, []);

  // ------------------------------------------------------------------ element <-> state

  useEffect(() => {
    const el = video.current;
    if (!el) return;
    el.volume = volume;
    el.muted = muted;
    el.playbackRate = rate;
  }, [volume, muted, rate]);

  useEffect(() => { savePrefs({ volume, muted, rate }); }, [volume, muted, rate]);

  useEffect(() => {
    const el = video.current;
    if (!el || scrubbing) return;
    if (Math.abs(el.currentTime * 1000 - currentMs) > SEEK_EPSILON_MS) {
      el.currentTime = currentMs / 1000;
    }
  }, [currentMs, scrubbing]);

  // the resume chip is an offer, not a nag
  useEffect(() => {
    if (resume == null) return;
    const t = setTimeout(() => setResume(null), 9000);
    return () => clearTimeout(t);
  }, [resume]);

  // leaving the view (or switching recording) is the one save that must not be missed
  useEffect(() => {
    const id = recordingId;
    return () => { if (lastMs.current > 1000) savePosition(id, lastMs.current); };
  }, [recordingId]);

  useEffect(() => () => {
    clearTimeout(hideTimer.current);
    clearTimeout(flashTimer.current);
  }, []);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === shell.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  rateOpenRef.current = rateOpen;

  useEffect(() => {
    if (!rateOpen) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as Element).closest("[data-rate-menu]")) setRateOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [rateOpen]);

  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void shell.current?.requestFullscreen().catch(() => {});
  }

  function togglePip() {
    const el = video.current;
    if (!el) return;
    if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => {});
    else void el.requestPictureInPicture().catch(() => {});
  }

  // ---------------------------------------------------------------------- keyboard

  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    keys.current = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      // the transcript's find box and the speaker rename field type letters too
      if (t?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName ?? "")) return;

      switch (e.key) {
        case " ": case "k": togglePlay(); break;
        case "j": skip(-SKIP_MS); break;
        case "l": skip(SKIP_MS); break;
        case "ArrowLeft": skip(-ARROW_MS); break;
        case "ArrowRight": skip(ARROW_MS); break;
        case "ArrowUp": setVolume((v) => Math.min(1, v + 0.05)); setMuted(false); break;
        case "ArrowDown": setVolume((v) => Math.max(0, v - 0.05)); setMuted(false); break;
        case "m": setMuted((m) => !m); break;
        case "f": toggleFullscreen(); break;
        case "p": if (hasVideo) togglePip(); break;
        case "Home": seek(0); break;
        case "End": seek(durationRef.current - 5000); break;
        case "<": case ",": setRate((r) => stepRate(r, -1)); break;
        case ">": case ".": setRate((r) => stepRate(r, 1)); break;
        default:
          if (!/^[0-9]$/.test(e.key)) return;
          seek((durationRef.current * Number(e.key)) / 10);
      }
      e.preventDefault();
      nudgeChrome();
    };
  });
  useEffect(() => {
    const h = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // ------------------------------------------------------------------------- render

  const chromeUp = chrome || !playing || scrubbing;
  const remaining = Math.max(0, duration - currentMs);

  return (
    <div
      ref={shell}
      onPointerMove={nudgeChrome}
      onPointerLeave={() => {
        overBar.current = false;
        if (playingRef.current && !rateOpenRef.current) setChrome(false);
      }}
      className={cn(
        "group/player relative isolate select-none overflow-hidden rounded-xl border bg-black text-white",
        hasVideo ? "aspect-video w-full" : "h-24 w-full",
        fullscreen && "aspect-auto size-full rounded-none border-0",
        !chromeUp && "cursor-none",
      )}
    >
      <video
        ref={video}
        // "none" = don't fetch until the user asks. seeking needs the 206 path in
        // media-protocol.ts; a 200-only handler makes a 1.8 GB file unseekable.
        preload="none"
        playsInline
        poster={hasVideo ? thumbUrl(recordingId) : undefined}
        src={mediaUrl(recordingId)}
        className={hasVideo ? "size-full object-contain" : "hidden"}
        onClick={togglePlay}
        onDoubleClick={toggleFullscreen}
        onPlay={() => { playingRef.current = true; setPlaying(true); nudgeChrome(); }}
        onPause={() => {
          playingRef.current = false;
          setPlaying(false);
          setChrome(true);
          if (lastMs.current > 1000) savePosition(recordingId, lastMs.current);
        }}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => setWaiting(false)}
        onCanPlay={() => setWaiting(false)}
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          setElDuration(Number.isFinite(el.duration) ? el.duration * 1000 : null);
          el.playbackRate = rate;
          el.volume = volume;
          el.muted = muted;
        }}
        onProgress={(e) => setBufferedMs(bufferedEnd(e.currentTarget))}
        onTimeUpdate={(e) => {
          const ms = e.currentTarget.currentTime * 1000;
          lastMs.current = ms;
          onTimeUpdate(ms);
          setBufferedMs(bufferedEnd(e.currentTarget));
          const now = Date.now();
          if (now - savedAt.current > POSITION_SAVE_MS) {
            savedAt.current = now;
            if (ms > 1000) savePosition(recordingId, ms);
          }
        }}
        onEnded={() => { clearPosition(recordingId); setPlaying(false); setChrome(true); }}
        onError={onError}
      />

      {!hasVideo && (
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-end gap-2 p-3 text-white/40">
          <Waveform className="size-4" />
          <span className="text-xs">Audio only</span>
        </div>
      )}

      {waiting && playing && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <SpinnerGap className="size-8 animate-spin text-white/80" />
        </div>
      )}

      {hasVideo && !playing && !waiting && (
        <button
          type="button"
          aria-label="Play"
          onClick={togglePlay}
          className="absolute inset-0 flex items-center justify-center outline-none"
        >
          <span className="flex size-16 items-center justify-center rounded-full bg-black/50 backdrop-blur-sm transition group-hover/player:bg-black/70">
            <Play weight="fill" className="size-7 translate-x-px" />
          </span>
        </button>
      )}

      {flash && (
        <div key={flash.n} className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="flex animate-in items-center gap-1.5 rounded-full bg-black/70 px-3 py-1.5 text-sm backdrop-blur-sm fade-in">
            {flash.back ? <ArrowCounterClockwise /> : <ArrowClockwise />}
            {flash.text}
          </span>
        </div>
      )}

      {resume != null && (
        <div className="absolute top-3 left-3 flex items-center gap-1 rounded-full bg-black/75 py-1 pr-1 pl-3 text-xs backdrop-blur-sm">
          <button
            type="button"
            className="outline-none hover:underline"
            onClick={() => { seek(resume); setResume(null); void video.current?.play().catch(() => {}); }}
          >
            Resume from {hms(resume)}
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            className="rounded-full p-1 text-white/60 outline-none hover:bg-white/15 hover:text-white"
            onClick={() => setResume(null)}
          >
            <X className="size-3" />
          </button>
        </div>
      )}

      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-black/85 via-black/40 to-transparent transition-opacity",
          chromeUp ? "opacity-100" : "opacity-0",
        )}
      />

      <div
        onPointerEnter={() => (overBar.current = true)}
        onPointerLeave={() => (overBar.current = false)}
        className={cn(
          "absolute inset-x-0 bottom-0 px-3 pb-1.5 transition-[opacity,translate] duration-200",
          chromeUp ? "opacity-100" : "pointer-events-none translate-y-2 opacity-0",
        )}
      >
        <PlayerTimeline
          recordingId={recordingId}
          durationMs={duration}
          currentMs={currentMs}
          bufferedMs={bufferedMs}
          hasVideo={hasVideo}
          bands={bands}
          palette={palette}
          nameFor={nameFor}
          onSeek={seek}
          onScrubbing={setScrubbing}
        />

        <div className="flex items-center gap-0.5">
          <IconBtn label={playing ? "Pause (k)" : "Play (k)"} onClick={togglePlay}>
            {playing ? <Pause weight="fill" /> : <Play weight="fill" />}
          </IconBtn>
          <IconBtn label="Back 10 seconds (j)" onClick={() => skip(-SKIP_MS)}>
            <ArrowCounterClockwise />
          </IconBtn>
          <IconBtn label="Forward 10 seconds (l)" onClick={() => skip(SKIP_MS)}>
            <ArrowClockwise />
          </IconBtn>

          <div className="group/vol flex items-center">
            <IconBtn label={muted ? "Unmute (m)" : "Mute (m)"} onClick={() => setMuted((m) => !m)}>
              {muted || volume === 0
                ? <SpeakerSimpleX />
                : volume < 0.5 ? <SpeakerLow /> : <SpeakerHigh />}
            </IconBtn>
            <div className="w-0 overflow-hidden transition-[width] duration-200 group-hover/vol:w-16 group-focus-within/vol:w-16">
              <VolumeRail
                value={muted ? 0 : volume}
                onChange={(v) => { setVolume(v); setMuted(v === 0); }}
              />
            </div>
          </div>

          <button
            type="button"
            onClick={() => setCountdown((c) => !c)}
            title="Switch between elapsed and remaining"
            className="ml-1 rounded-md px-1 font-mono text-xs tabular-nums text-white/85 outline-none hover:text-white"
          >
            {countdown ? `-${hms(remaining)}` : hms(currentMs)}
            <span className="text-white/40"> / {hms(duration)}</span>
          </button>

          <div className="flex-1" />

          <div className="relative" data-rate-menu>
            <button
              type="button"
              aria-label="Playback speed"
              onClick={() => setRateOpen((o) => !o)}
              className="h-7 rounded-md px-2 text-xs font-medium tabular-nums text-white/85 outline-none hover:bg-white/15 hover:text-white"
            >
              {rate}&times;
            </button>
            {rateOpen && (
              // deliberately not a portal: a portalled popover renders outside the
              // fullscreen element and is invisible while fullscreen
              <div className="absolute right-0 bottom-full mb-2 w-20 rounded-lg border border-white/10 bg-black/90 p-1 shadow-lg backdrop-blur">
                {RATES.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => { setRate(r); setRateOpen(false); }}
                    className={cn(
                      "flex w-full items-center justify-between rounded-md px-2 py-1 text-xs tabular-nums outline-none hover:bg-white/15",
                      r === rate ? "text-white" : "text-white/70",
                    )}
                  >
                    {r}&times;{r === rate && <span className="size-1.5 rounded-full bg-white" />}
                  </button>
                ))}
              </div>
            )}
          </div>

          {hasVideo && document.pictureInPictureEnabled && (
            <IconBtn label="Picture in picture (p)" onClick={togglePip}>
              <PictureInPicture />
            </IconBtn>
          )}
          {hasVideo && (
            <IconBtn label={fullscreen ? "Exit full screen (f)" : "Full screen (f)"} onClick={toggleFullscreen}>
              {fullscreen ? <CornersIn /> : <CornersOut />}
            </IconBtn>
          )}
        </div>
      </div>
    </div>
  );
}

function IconBtn({ label, onClick, children }: {
  label: string; onClick: () => void; children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex size-7 items-center justify-center rounded-md text-white/85 outline-none transition hover:bg-white/15 hover:text-white focus-visible:ring-2 focus-visible:ring-white/70 [&_svg]:size-[17px]"
    >
      {children}
    </button>
  );
}

function VolumeRail({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const rail = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  function set(clientX: number) {
    const box = rail.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    onChange(Math.round(Math.min(1, Math.max(0, (clientX - box.left) / box.width)) * 100) / 100);
  }

  return (
    <div
      ref={rail}
      role="slider"
      aria-label="Volume"
      aria-valuenow={Math.round(value * 100)}
      tabIndex={0}
      className="relative flex h-7 w-16 shrink-0 cursor-pointer touch-none items-center px-1.5"
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setDragging(true); set(e.clientX); }}
      onPointerMove={(e) => { if (dragging) set(e.clientX); }}
      onPointerUp={(e) => { e.currentTarget.releasePointerCapture(e.pointerId); setDragging(false); }}
    >
      <div className="h-[3px] w-full overflow-hidden rounded-full bg-white/30">
        <div className="h-full bg-white" style={{ width: `${value * 100}%` }} />
      </div>
      <span
        className="pointer-events-none absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white"
        style={{ left: `calc(0.375rem + ${value} * (100% - 0.75rem))` }}
      />
    </div>
  );
}

/** End of the buffered range holding the playhead — what the timeline draws as "loaded". */
function bufferedEnd(el: HTMLVideoElement): number {
  const t = el.currentTime;
  for (let i = 0; i < el.buffered.length; i++) {
    if (el.buffered.start(i) <= t + 0.25 && el.buffered.end(i) >= t) return el.buffered.end(i) * 1000;
  }
  return el.buffered.length ? el.buffered.end(el.buffered.length - 1) * 1000 : 0;
}
