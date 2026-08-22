import { describe, expect, it } from "vitest";
import type { Speaker } from "../src/shared/ipc";
import { speakerPalette } from "../src/renderer/src/lib/speakerColor";

const spk = (id: number, person_id: number | null = null, recording_id = 1): Speaker => ({
  id,
  recording_id,
  label: `Speaker ${id}`,
  display_name: null,
  person_id,
});

describe("speakerPalette", () => {
  it("gives every voice in a recording its own colour", () => {
    const speakers = [1, 2, 3, 4, 5, 6, 7, 8].map((id) => spk(id));
    const p = speakerPalette(speakers);
    const slots = speakers.map((s) => p.slotOf(s.id));
    expect(new Set(slots).size).toBe(speakers.length);
  });

  it("keeps a speaker's colour when the list arrives in another order", () => {
    const speakers = [spk(3), spk(9), spk(4)];
    const a = speakerPalette(speakers);
    const b = speakerPalette([...speakers].reverse());
    for (const s of speakers) expect(b.slotOf(s.id)).toBe(a.slotOf(s.id));
  });

  it("keeps a speaker's colour when another one is renamed or merged away", () => {
    const before = speakerPalette([spk(3), spk(9), spk(4)]);
    const after = speakerPalette([spk(3), spk(4)]);
    expect(after.slotOf(3)).toBe(before.slotOf(3));
    expect(after.slotOf(4)).toBe(before.slotOf(4));
  });

  it("carries one person's colour across recordings", () => {
    const here = speakerPalette([spk(2, 7), spk(3, 8)]);
    const there = speakerPalette([spk(41, 7), spk(42, 8)]);
    expect(there.slotOf(41)).toBe(here.slotOf(2));
    expect(there.slotOf(42)).toBe(here.slotOf(3));
  });

  it("leaves unattributed stretches colourless", () => {
    const p = speakerPalette([spk(1)]);
    expect(p.slotOf(null)).toBeNull();
    expect(p.ui(null)).toBe("var(--muted-foreground)");
    expect(p.onDark(1)).not.toBe(p.onDark(null));
  });

  it("still answers for a speaker it was never given", () => {
    const p = speakerPalette([]);
    expect(p.onDark(99)).toMatch(/^oklch\(/);
  });
});
