import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PipelineError } from "../src/main/errors";
import {
  bundledCandidates,
  discover,
  extractPcm,
  probe,
  progressMs,
} from "../src/main/media/ffmpeg";
import { mixPcm, pcmBytesForMs, pcmDurationMs, readPcmF32 } from "../src/main/media/pcm";
import { AUTO, parseRule, select } from "../src/main/media/track";
import type { AudioStream, Probe } from "../src/main/media/types";

const dir = mkdtempSync(join(tmpdir(), "unottr-media-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const slugOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof PipelineError ? e.slug : `not a PipelineError: ${String(e)}`;
  }
  return "did not throw";
};

// ------------------------------------------------------------------------ track rules

const stream = (audioIndex: number, channels: number, title: string | null): AudioStream => ({
  index: audioIndex + 1,
  audio_index: audioIndex,
  codec: "aac",
  channels,
  sample_rate: 48_000,
  title,
  language: null,
});

const probeOf = (audio: AudioStream[]): Probe => ({
  container: "matroska",
  duration_ms: 1000,
  has_video: true,
  audio,
});

describe("track selection", () => {
  it("takes a single track blind", () => {
    expect(select(probeOf([stream(0, 2, null)]), AUTO).selection).toEqual({
      kind: "blind",
      stream: 0,
    });
  });

  it("splits mic and desktop by title", () => {
    const p = probeOf([
      stream(0, 2, "Mix"),
      stream(1, 2, "Microphone"),
      stream(2, 2, "Desktop Audio"),
    ]);
    expect(select(p, AUTO).selection).toEqual({ kind: "mic_desktop", mic: 1, desktop: 2 });
  });

  it("treats a lone mono track as the mic", () => {
    const p = probeOf([stream(0, 2, null), stream(1, 1, null)]);
    expect(select(p, AUTO).selection).toEqual({ kind: "mic_desktop", mic: 1, desktop: 0 });
  });

  it("does not guess between two mono tracks", () => {
    const p = probeOf([stream(0, 1, null), stream(1, 1, null)]);
    expect(select(p, AUTO).selection).toEqual({ kind: "blind", stream: 0 });
  });

  it("falls back to the first of an unidentifiable multitrack", () => {
    const p = probeOf([stream(0, 2, "Track 1"), stream(1, 2, "Track 2")]);
    expect(select(p, AUTO).selection).toEqual({ kind: "blind", stream: 0 });
  });

  it("lets an override beat the heuristic", () => {
    const p = probeOf([stream(0, 2, null), stream(1, 1, null)]);
    const choice = select(p, { kind: "stream", stream: 0 });
    expect(choice.selection).toEqual({ kind: "blind", stream: 0 });
    expect(choice.reason).toBe("track 0 forced by configuration");
  });

  it("rejects an override to a missing track", () => {
    expect(slugOf(() => select(probeOf([stream(0, 2, null)]), { kind: "stream", stream: 7 }))).toBe(
      "probe_failed",
    );
  });

  it("rejects a file with no audio", () => {
    expect(slugOf(() => select(probeOf([]), AUTO))).toBe("no_audio");
  });
});

describe("parseRule", () => {
  it("round-trips the two json forms", () => {
    expect(parseRule('{"kind":"stream","stream":2}')).toEqual({ kind: "stream", stream: 2 });
    expect(parseRule('{"kind":"mic_desktop","mic":1,"desktop":0}')).toEqual({
      kind: "mic_desktop",
      mic: 1,
      desktop: 0,
    });
  });

  it("falls back to auto rather than failing a scan", () => {
    for (const bad of ["auto", "", "not json", "{}", '{"kind":"stream"}', "null"]) {
      expect(parseRule(bad)).toEqual(AUTO);
    }
  });
});

// -------------------------------------------------------------------------------- pcm

describe("pcm maths", () => {
  it("converts between bytes and duration", () => {
    expect(pcmBytesForMs(1000)).toBe(32_000);
    expect(pcmDurationMs(32_000)).toBe(1000);
    expect(pcmDurationMs(pcmBytesForMs(1234))).toBe(1234);
  });

  it("reads s16le as normalised f32", () => {
    const path = join(dir, "read.pcm");
    const buf = Buffer.alloc(8);
    buf.writeInt16LE(0, 0);
    buf.writeInt16LE(32767, 2);
    buf.writeInt16LE(-32768, 4);
    buf.writeInt16LE(16384, 6);
    writeFileSync(path, buf);

    const f32 = readPcmF32(path);
    expect(Array.from(f32)).toEqual([0, 32767 / 32768, -1, 0.5]);
  });

  it("drops a trailing odd byte instead of misreading it", () => {
    const path = join(dir, "odd.pcm");
    writeFileSync(path, Buffer.from([0x00, 0x40, 0x7f]));
    expect(readPcmF32(path).length).toBe(1);
  });

  it("sums tracks and pads the shorter one with silence", () => {
    const a = join(dir, "a.pcm");
    const b = join(dir, "b.pcm");
    const out = join(dir, "mix.pcm");
    writeFileSync(a, i16([100, 200, 300]));
    writeFileSync(b, i16([50, 50]));

    mixPcm([a, b], out);
    expect(samples(out)).toEqual([150, 250, 300]);
  });

  it("scales down instead of clipping", () => {
    const a = join(dir, "loud-a.pcm");
    const b = join(dir, "loud-b.pcm");
    const out = join(dir, "loud.pcm");
    writeFileSync(a, i16([30000, -30000]));
    writeFileSync(b, i16([30000, -30000]));

    mixPcm([a, b], out);
    // peak 60000 -> gain 32767/60000, so the sum lands exactly on full scale
    expect(samples(out)).toEqual([32767, -32767]);
  });

  it("reports the path when a source is missing", () => {
    expect(slugOf(() => mixPcm([join(dir, "nope.pcm")], join(dir, "x.pcm")))).toBe("io_error");
  });
});

const i16 = (values: number[]): Buffer => {
  const buf = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => buf.writeInt16LE(v, i * 2));
  return buf;
};

const samples = (path: string): number[] => {
  const buf = readFileSync(path);
  return Array.from({ length: buf.length / 2 }, (_, i) => buf.readInt16LE(i * 2));
};

// ---------------------------------------------------------------------------- progress

describe("progressMs", () => {
  it("reads both spellings as microseconds", () => {
    expect(progressMs("out_time_us=1500000")).toBe(1500);
    expect(progressMs("out_time_ms=1500000")).toBe(1500);
  });

  it("ignores every other line", () => {
    for (const line of ["out_time=00:00:01.5", "progress=continue", "frame=12", "", "="]) {
      expect(progressMs(line)).toBeNull();
    }
  });

  it("rejects ffmpeg's not-yet-started sentinels", () => {
    expect(progressMs("out_time_us=N/A")).toBeNull();
    expect(progressMs("out_time_us=-9223372036854")).toBeNull();
  });
});

describe("bundled FFmpeg discovery", () => {
  it("prefers a platform-qualified Apple Silicon resource", () => {
    expect(
      bundledCandidates("ffmpeg", {
        platform: "darwin",
        arch: "arm64",
        resourcesPath: "/Applications/unottr.app/Contents/Resources",
        execPath: "/Applications/unottr.app/Contents/MacOS/unottr",
        cwd: "/checkout",
      }).slice(0, 2),
    ).toEqual([
      "/Applications/unottr.app/Contents/Resources/bin/darwin-arm64/ffmpeg",
      "/Applications/unottr.app/Contents/Resources/bin/ffmpeg",
    ]);
  });

  it("uses executable suffixes in Windows resource paths", () => {
    expect(
      bundledCandidates("ffmpeg", {
        platform: "win32",
        arch: "x64",
        resourcesPath: "C:\\Program Files\\unottr\\resources",
        execPath: "C:\\Program Files\\unottr\\unottr.exe",
        cwd: "C:\\checkout",
      }).slice(0, 2),
    ).toEqual([
      "C:\\Program Files\\unottr\\resources/bin/win32-x64/ffmpeg.exe",
      "C:\\Program Files\\unottr\\resources/bin/ffmpeg.exe",
    ]);
  });
});

// -------------------------------------------------------------------- ffmpeg, for real

const cli = discover();
const haveFfmpeg = spawnSync(cli.ffmpeg, ["-version"], { stdio: "ignore" }).status === 0;

/** An mkv of `seconds` with one titled audio track per entry, same shape as tests/media.rs. */
function fixture(out: string, seconds: number, tracks: [string, number][]): void {
  const args = ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=black:s=64x64:d=${seconds}`];
  tracks.forEach((_, i) => {
    args.push("-f", "lavfi", "-i", `sine=frequency=${200 + i * 150}:duration=${seconds}`);
  });
  args.push("-map", "0:v", "-pix_fmt", "yuv420p");
  tracks.forEach(([title, channels], i) => {
    args.push("-map", `${i + 1}:a`, `-ac:a:${i}`, String(channels), `-metadata:s:a:${i}`, `title=${title}`);
  });
  args.push(out);
  const r = spawnSync(cli.ffmpeg, args, { stdio: "ignore" });
  if (r.status !== 0) throw new Error("building fixture failed");
}

describe.skipIf(!haveFfmpeg)("ffmpeg", () => {
  it("probes a real multi-track file", async () => {
    const media = join(dir, "meeting.mkv");
    fixture(media, 3, [
      ["Mix", 2],
      ["Microphone", 1],
      ["Desktop Audio", 2],
    ]);

    const p = await probe(cli, media);
    expect(p.has_video).toBe(true);
    expect(p.audio.length).toBe(3);
    expect(p.audio[1].channels).toBe(1);
    expect(p.audio[1].title).toBe("Microphone");
    expect(p.audio.map((s) => s.audio_index)).toEqual([0, 1, 2]);
    expect(Math.abs((p.duration_ms ?? 0) - 3000)).toBeLessThan(100);

    expect(select(p, AUTO).selection).toEqual({ kind: "mic_desktop", mic: 1, desktop: 2 });
  });

  it("extracts one track to 16 kHz mono pcm, creating the directory", async () => {
    const media = join(dir, "extract.mkv");
    fixture(media, 2, [["Mix", 2]]);
    const out = join(dir, "nested/extract.pcm");

    const seen: number[] = [];
    await extractPcm(cli, media, { audioIndex: 0, out, onProgress: (p) => seen.push(p) });

    const extracted = pcmDurationMs(statSync(out).size);
    expect(Math.abs(extracted - 2000)).toBeLessThan(100);
    expect(seen.at(-1)).toBe(1);
  });

  it("writes nothing when cancelled before it starts", async () => {
    const media = join(dir, "cancelled.mkv");
    fixture(media, 1, [["Mix", 2]]);
    const out = join(dir, "cancelled.pcm");

    const ac = new AbortController();
    ac.abort();
    await expect(extractPcm(cli, media, { audioIndex: 0, out, signal: ac.signal })).rejects.toThrow(
      /cancelled/,
    );
    expect(() => statSync(out)).toThrow();
  });

  it("rejects a video with no audio", async () => {
    const media = join(dir, "silent.mkv");
    fixture(media, 1, []);
    await expect(probe(cli, media)).rejects.toMatchObject({ detail: { kind: "no_audio" } });
  });

  it("rejects a truncated mp4", async () => {
    const whole = join(dir, "whole.mp4");
    fixture(whole, 5, [["Mix", 2]]);
    const cut = join(dir, "cut.mp4");
    const bytes = readFileSync(whole);
    writeFileSync(cut, bytes.subarray(0, Math.floor(bytes.length / 2)));

    await expect(probe(cli, cut)).rejects.toMatchObject({ detail: { kind: "truncated" } });
  });

  it("reports a missing file as io, not as a probe failure", async () => {
    await expect(probe(cli, join(dir, "gone.mkv"))).rejects.toMatchObject({
      detail: { kind: "io_error" },
    });
  });
});
