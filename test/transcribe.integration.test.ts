// The one test that actually runs whisper. Everything else in 08.4 is checked against the
// oracle json; this checks that the json was produced from the same audio the addon hears.
//
// Needs the models on disk and the jfk sample the fixture was built from, so it skips
// rather than fails anywhere else.

import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discover, extractPcm } from "../src/main/media/ffmpeg";
import { VAD, findWhisper } from "../src/main/models/catalog";
import { isPresent, modelPath } from "../src/main/models/download";
import { pack, range } from "../src/worker/chunk";
import { detectSpeech } from "../src/worker/vad";
import { Transcriber, type Utterance, defaultOptions } from "../src/worker/whisper";
import { chunksOf } from "./fixtures";

const SOURCE = JSON.parse(readFileSync("fixtures/jfk/meta.json", "utf8")).source.path as string;
const MODEL = findWhisper("base.en");

const ready = MODEL !== undefined && isPresent(MODEL) && isPresent(VAD) && existsSync(SOURCE);

describe.skipIf(!ready)("whisper and vad on jfk.wav", () => {
  const fixture = chunksOf("jfk");
  const expected = JSON.parse(readFileSync("fixtures/jfk/utterances.json", "utf8")) as {
    chunk_idx: number;
    utterances: Utterance[];
  }[];

  let dir: string;
  let pcm: Buffer;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "unottr-jfk-"));
    const out = join(dir, "audio.pcm");
    await extractPcm(discover(), SOURCE, { audioIndex: 0, out });
    pcm = readFileSync(out);
  }, 60_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("detects the same speech spans the rust build did", async () => {
    // silero is deterministic and both builds run the same graph, so this is exact rather
    // than within a tolerance. if it ever stops being, the plan allows relaxing it.
    expect(await detectSpeech(pcm, modelPath(VAD))).toEqual(fixture.spans);
  }, 60_000);

  it("transcribes to the fixture text with the fixture word timings", async () => {
    const chunks = pack(await detectSpeech(pcm, modelPath(VAD)));
    expect(chunks).toEqual(fixture.chunks);

    // gpu, like the fixture run; the decode is greedy so the device does not change the text
    const transcriber = await Transcriber.load(modelPath(MODEL!), "gpu", defaultOptions());
    let got: Utterance[];
    try {
      const { lo, hi } = range(chunks[0], pcm.length >> 1);
      got = await transcriber.run(pcm.subarray(lo * 2, hi * 2));
    } finally {
      await transcriber.release();
    }

    // fixture times are absolute, ours are relative to the chunk
    const offset = chunks[0].start_ms;
    const want = expected[0].utterances;
    expect(got.map((u) => u.text)).toEqual(want.map((u) => u.text));
    expect(got.map((u) => u.words.map((w) => w.text))).toEqual(
      want.map((u) => u.words.map((w) => w.text)),
    );

    const gotWords = got.flatMap((u) => u.words);
    const wantWords = want.flatMap((u) => u.words);
    gotWords.forEach((w, i) => {
      expect(w.start_ms + offset).toBe(wantWords[i].start_ms);
      // deviation: the addon exposes segments, not tokens, so a word runs to the next word's
      // onset where rust had the token's own end. never earlier, never past the next word.
      expect(w.end_ms + offset).toBeGreaterThanOrEqual(wantWords[i].end_ms);
      expect(w.end_ms).toBeLessThanOrEqual(gotWords[i + 1]?.start_ms ?? w.end_ms);
    });
    // and the utterance still ends where the fixture's does
    expect(got.at(-1)!.end_ms + offset).toBe(want.at(-1)!.end_ms);
  }, 120_000);
});
