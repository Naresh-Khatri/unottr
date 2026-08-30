// One colour per voice, held steady wherever that voice appears: the timeline ribbon, the
// transcript headers, the speaker chips. The rest of the ui is deliberately greyscale, so
// hue means exactly one thing here — "who is talking".

import type { Speaker } from "../../../shared/ipc";

/** Eight hues, far enough apart to tell apart in a 4px band. Order = first-claimed order. */
const HUES = [255, 35, 155, 320, 200, 90, 285, 10];

/** Same L/C for every hue so no voice reads as louder than another. */
const onDarkColor = (hue: number): string => `oklch(0.74 0.15 ${hue})`;
const uiColor = (hue: number): string =>
  `light-dark(oklch(0.5 0.16 ${hue}), oklch(0.79 0.14 ${hue}))`;

const UNATTRIBUTED_ON_DARK = "oklch(1 0 0 / 0.16)";
const UNATTRIBUTED_UI = "var(--muted-foreground)";

export interface SpeakerPalette {
  /** on the player's own black chrome, which ignores the app theme */
  onDark: (sid: number | null) => string;
  /** on the app's surfaces, light or dark */
  ui: (sid: number | null) => string;
  slotOf: (sid: number | null) => number | null;
}

/** The stable identity colour used when a person is shown without a recording's speaker row. */
export function personColor(personId: number): string {
  return uiColor(HUES[hash(`p${personId}`) % HUES.length]);
}

/**
 * A speaker's slot is derived from their identity, not their position in the list, so a
 * merge, a rename or a re-diarize doesn't reshuffle everyone's colour. A speaker linked to a
 * person keys off the person, so one voice keeps one colour across the whole library.
 */
export function speakerPalette(speakers: Speaker[]): SpeakerPalette {
  const slots = new Map<number, number>();
  const taken = new Set<number>();

  // id order, not list order: whoever claims a hue must not depend on how the list arrived
  for (const s of [...speakers].sort((a, b) => a.id - b.id)) {
    const want = hash(s.person_id != null ? `p${s.person_id}` : `s${s.id}`) % HUES.length;
    let slot = want;
    // probe forward so two voices in one recording never land on the same hue
    for (let i = 1; i < HUES.length && taken.has(slot); i++) slot = (want + i) % HUES.length;
    taken.add(slot);
    slots.set(s.id, slot);
  }

  const slotOf = (sid: number | null): number | null =>
    sid == null ? null : slots.get(sid) ?? hash(`s${sid}`) % HUES.length;

  return {
    slotOf,
    onDark: (sid) => {
      const slot = slotOf(sid);
      return slot == null ? UNATTRIBUTED_ON_DARK : onDarkColor(HUES[slot]);
    },
    ui: (sid) => {
      const slot = slotOf(sid);
      return slot == null ? UNATTRIBUTED_UI : uiColor(HUES[slot]);
    },
  };
}

/** FNV-1a — cheap, and its low bits spread, which is all the modulo below reads. */
function hash(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
