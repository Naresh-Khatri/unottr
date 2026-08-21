// Player state that outlives a view: volume/mute/rate globally, a resume point per recording.
// localStorage, not the settings table — this is renderer-only view state and a write every
// few seconds of playback has no business crossing ipc.

import type { Segment } from "../../../shared/ipc";

const PREFS_KEY = "unottr.player.prefs";
const POSITIONS_KEY = "unottr.player.positions";

// bounded so a library of thousands of recordings can't grow the blob without limit
const MAX_POSITIONS = 300;

export const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

export interface PlayerPrefs {
  volume: number; // 0..1
  muted: boolean;
  rate: number;
}

const DEFAULT_PREFS: PlayerPrefs = { volume: 1, muted: false, rate: 1 };

export function loadPrefs(): PlayerPrefs {
  const raw = read<Partial<PlayerPrefs>>(PREFS_KEY);
  if (!raw) return DEFAULT_PREFS;
  return {
    volume: clamp01(num(raw.volume, DEFAULT_PREFS.volume)),
    muted: raw.muted === true,
    // a stored rate outside the menu would leave the button showing something unpickable
    rate: RATES.includes(num(raw.rate, 1)) ? num(raw.rate, 1) : 1,
  };
}

export function savePrefs(prefs: PlayerPrefs): void {
  write(PREFS_KEY, prefs);
}

export function loadPosition(recordingId: number): number | null {
  const all = read<Record<string, number>>(POSITIONS_KEY);
  const ms = all?.[String(recordingId)];
  return typeof ms === "number" && ms > 0 ? ms : null;
}

export function savePosition(recordingId: number, ms: number): void {
  const all = read<Record<string, number>>(POSITIONS_KEY) ?? {};
  delete all[String(recordingId)]; // re-insert last so the trim below is oldest-first
  all[String(recordingId)] = Math.round(ms);
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_POSITIONS))) delete all[k];
  write(POSITIONS_KEY, all);
}

export function clearPosition(recordingId: number): void {
  const all = read<Record<string, number>>(POSITIONS_KEY);
  if (!all || !(String(recordingId) in all)) return;
  delete all[String(recordingId)];
  write(POSITIONS_KEY, all);
}

/** Below this a resume offer is noise; within this of the end it's a rewatch, not a resume. */
const RESUME_MIN_MS = 20_000;
const RESUME_END_GUARD_MS = 25_000;

/** The moment worth offering to jump back to, or null if the saved one isn't worth a chip. */
export function resumeOffer(saved: number | null, durationMs: number | null): number | null {
  if (saved == null || saved < RESUME_MIN_MS) return null;
  if (durationMs != null && saved > durationMs - RESUME_END_GUARD_MS) return null;
  return saved;
}

export interface SpeakerBand {
  sid: number | null;
  start_ms: number;
  end_ms: number;
}

/**
 * Consecutive segments by one voice collapsed into one band — the timeline's speaker map, so
 * "who is talking, and when" is readable without scrolling the transcript.
 */
export function speakerBands(segments: Pick<Segment, "speaker_id" | "start_ms" | "end_ms">[]): SpeakerBand[] {
  const bands: SpeakerBand[] = [];
  for (const seg of segments) {
    const last = bands[bands.length - 1];
    if (last && last.sid === seg.speaker_id && seg.start_ms <= last.end_ms + 1500) {
      last.end_ms = Math.max(last.end_ms, seg.end_ms);
    } else {
      bands.push({ sid: seg.speaker_id, start_ms: seg.start_ms, end_ms: seg.end_ms });
    }
  }
  return bands;
}

/** Next rate in the menu; clamps at the ends rather than wrapping 2x back to 0.5x. */
export function stepRate(current: number, dir: 1 | -1): number {
  const i = RATES.indexOf(current);
  const from = i === -1 ? RATES.indexOf(1) : i;
  return RATES[Math.min(RATES.length - 1, Math.max(0, from + dir))];
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

// a corrupt or full store must never take the player down with it
function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota or private mode — losing a resume point is not worth an error */
  }
}
