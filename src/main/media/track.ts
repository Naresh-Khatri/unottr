// Port of crates/unottr-core/src/media/track.rs. Pure logic — no filesystem, no ffmpeg.

import { err } from "../errors";
import type { Probe } from "./types";
import { streamOf } from "./types";

/**
 * What the user (or a watch folder) asked for. `audio_index`-based throughout, because
 * "track 2" is the concept people have, not a global stream index.
 */
export type TrackRule =
  | { kind: "auto" }
  | { kind: "stream"; stream: number }
  | { kind: "mic_desktop"; mic: number; desktop: number };

/** What the pipeline will actually do. */
export type Selection =
  /** One mixed track; diarization has to separate everyone by voice. */
  | { kind: "blind"; stream: number }
  /** Mic is a known speaker, so only the remote participants need diarizing. */
  | { kind: "mic_desktop"; mic: number; desktop: number };

export interface TrackChoice {
  selection: Selection;
  /** Logged. When a user reports bad speaker labels this is the first thing to read. */
  reason: string;
}

export const AUTO: TrackRule = { kind: "auto" };

/** Parses the `watch_folders.track_rule` column; garbage falls back to auto, never fails a scan. */
export function parseRule(text: string): TrackRule {
  if (text === "auto") return AUTO;
  try {
    const v = JSON.parse(text) as Partial<TrackRule> & Record<string, unknown>;
    if (v.kind === "stream" && typeof v.stream === "number") {
      return { kind: "stream", stream: v.stream };
    }
    if (v.kind === "mic_desktop" && typeof v.mic === "number" && typeof v.desktop === "number") {
      return { kind: "mic_desktop", mic: v.mic, desktop: v.desktop };
    }
  } catch {
    // fall through
  }
  return AUTO;
}

export function select(probe: Probe, rule: TrackRule): TrackChoice {
  if (probe.audio.length === 0) throw err.noAudio("");

  switch (rule.kind) {
    case "stream":
      require_(probe, rule.stream);
      return {
        selection: { kind: "blind", stream: rule.stream },
        reason: `track ${rule.stream} forced by configuration`,
      };
    case "mic_desktop":
      require_(probe, rule.mic);
      require_(probe, rule.desktop);
      return {
        selection: { kind: "mic_desktop", mic: rule.mic, desktop: rule.desktop },
        reason: `mic=${rule.mic} desktop=${rule.desktop} forced by configuration`,
      };
    case "auto":
      return auto(probe);
  }
}

function auto(probe: Probe): TrackChoice {
  const first = probe.audio[0].audio_index;

  // 1. single track: every OBS simple-mode recording lands here
  if (probe.audio.length === 1) {
    return { selection: { kind: "blind", stream: first }, reason: "single audio track" };
  }

  // 2. named tracks. mkv keeps titles; mp4 usually drops them, so this rarely fires
  const mic = probe.audio.find((s) => titleHas(s.title, ["mic"]));
  const desktop = probe.audio.find((s) => titleHas(s.title, ["desktop", "system", "speaker"]));
  if (mic && desktop && mic.audio_index !== desktop.audio_index) {
    return {
      selection: { kind: "mic_desktop", mic: mic.audio_index, desktop: desktop.audio_index },
      reason: `track titles: mic=${quote(mic.title)} desktop=${quote(desktop.title)}`,
    };
  }

  // 3. exactly one mono track among stereo ones: the mono one is almost certainly a mic
  const monos = probe.audio.filter((s) => s.channels === 1);
  if (monos.length === 1) {
    const multi = probe.audio.find((s) => s.channels > 1);
    if (multi) {
      return {
        selection: { kind: "mic_desktop", mic: monos[0].audio_index, desktop: multi.audio_index },
        reason: `one mono track (${monos[0].audio_index}) among ${probe.audio.length - 1} multi-channel tracks`,
      };
    }
  }

  // 4. give up and take the first track
  return {
    selection: { kind: "blind", stream: first },
    reason: `${probe.audio.length} tracks, none identifiable; using the first`,
  };
}

const titleHas = (title: string | null, needles: string[]): boolean =>
  title !== null && needles.some((n) => title.toLowerCase().includes(n));

// rust formats these with {:?}, so an absent title reads as "" not "null"
const quote = (title: string | null): string => JSON.stringify(title ?? "");

function require_(probe: Probe, audioIndex: number): void {
  if (streamOf(probe, audioIndex) === undefined) {
    throw err.probe("", `audio track ${audioIndex} does not exist; file has ${probe.audio.length}`);
  }
}
