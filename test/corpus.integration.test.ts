// The full pipeline over the three real recordings the oracle was built from: ~17 minutes of
// gpu time, so it only runs under UNOTTR_CORPUS=1. It is what proves the ported clustering
// finds the same people the rust build did, which no fixture-driven test can.
//
//   UNOTTR_CORPUS=1 pnpm vitest run test/corpus.integration.test.ts

import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { discover, extractPcm } from "../src/main/media/ffmpeg";
import { decodeS16 } from "../src/main/media/pcm";
import { SEGMENTATION, VAD, findEmbedding, findWhisper } from "../src/main/models/catalog";
import { isPresent, modelPath } from "../src/main/models/download";
import { pack, range } from "../src/worker/chunk";
import { Diarizer, defaultConfig } from "../src/worker/diarize";
import { assign } from "../src/worker/merge";
import { detectSpeech } from "../src/worker/vad";
import { Transcriber, defaultOptions, shift } from "../src/worker/whisper";
import { chunksOf, mergedOf, turnsOf } from "./fixtures";

const CORPUS = ["corpus-01", "corpus-02", "corpus-03"];
const EMBEDDING = findEmbedding("campplus-zh-en")!;

interface Meta {
  source: { path: string };
  whisper_model: string;
  audio_s: number;
  speakers: number;
  timing: { transcribe_rtf_over_speech: number; diarize_rtf_over_audio: number };
}

const metaOf = (name: string): Meta =>
  JSON.parse(readFileSync(`fixtures/${name}/meta.json`, "utf8")) as Meta;

const ready =
  process.env.UNOTTR_CORPUS === "1" &&
  isPresent(VAD) &&
  isPresent(SEGMENTATION) &&
  isPresent(EMBEDDING) &&
  CORPUS.every((n) => existsSync(metaOf(n).source.path) && isPresent(findWhisper(metaOf(n).whisper_model)!));

describe.skipIf(!ready)("the whole pipeline on the corpus", () => {
  let dir: string | undefined;
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  for (const name of CORPUS) {
    it(
      `finds ${metaOf(name).speakers} speakers in ${name}`,
      async () => {
        const meta = metaOf(name);
        dir ??= await mkdtemp(join(tmpdir(), "unottr-corpus-"));
        const out = join(dir, `${name}.pcm`);
        await extractPcm(discover(), meta.source.path, { audioIndex: 0, out });
        const pcm = readFileSync(out);

        const chunks = pack(await detectSpeech(pcm, modelPath(VAD)));
        expect(chunks).toEqual(chunksOf(name).chunks);

        let t0 = Date.now();
        const transcriber = await Transcriber.load(
          modelPath(findWhisper(meta.whisper_model)!),
          "gpu",
          defaultOptions(),
        );
        const utterances = [];
        try {
          for (const chunk of chunks) {
            const { lo, hi } = range(chunk, pcm.length >> 1);
            const got = await transcriber.run(pcm.subarray(lo * 2, hi * 2));
            utterances.push(...got.map((u) => ({ chunk, u: shift(u, chunk.start_ms) })));
          }
        } finally {
          await transcriber.release();
        }
        const speechS = chunks.reduce((ms, c) => ms + (c.end_ms - c.start_ms), 0) / 1000;
        const transcribeRtf = speechS / ((Date.now() - t0) / 1000);

        t0 = Date.now();
        const diarizer = Diarizer.load(
          modelPath(SEGMENTATION),
          modelPath(EMBEDDING),
          defaultConfig(),
        );
        const result = await diarizer.run(decodeS16(pcm), () => {});
        const diarizeRtf = meta.audio_s / ((Date.now() - t0) / 1000);

        // the acceptance: the same head count as DESIGN.md and the oracle
        expect(new Set(result.turns.map((t) => t.speaker)).size).toBe(meta.speakers);
        expect(result.embeddings).toHaveLength(meta.speakers);

        // and the transcript still attributes: every segment lands on a speaker or on nothing
        const merged = assign(
          utterances.map(({ chunk, u }, i) => ({
            id: i + 1,
            chunk_idx: chunk.idx,
            start_ms: u.start_ms,
            end_ms: u.end_ms,
            text: u.text,
            words: u.words,
          })),
          result.turns,
        );
        const unattributed = merged.filter((m) => m.pieces.every((p) => p.speaker === null)).length;
        expect(unattributed / merged.length).toBeLessThan(0.1);

        // rtf is machine-dependent, so it is reported rather than asserted past a floor that
        // only a wrong backend (cpu instead of vulkan) could fall through
        console.log(
          `${name}: transcribe ${transcribeRtf.toFixed(1)}x (oracle ${meta.timing.transcribe_rtf_over_speech}x), ` +
            `diarize ${diarizeRtf.toFixed(1)}x (oracle ${meta.timing.diarize_rtf_over_audio}x), ` +
            `${merged.length} segments, ${unattributed} unattributed, ` +
            `oracle ${mergedOf(name).segments.length} segments / ${turnsOf(name).turns.length} turns`,
        );
        expect(transcribeRtf).toBeGreaterThan(meta.timing.transcribe_rtf_over_speech * 0.5);
        // diarization has no gpu path -- sherpa is cpu ort either way -- so this floor cannot
        // catch a wrong backend the way the transcribe one can. Loose enough to survive a busy
        // machine (0.497 of the oracle on a loaded run), tight enough to catch an algorithmic
        // regression.
        expect(diarizeRtf).toBeGreaterThan(meta.timing.diarize_rtf_over_audio * 0.25);
      },
      // a loaded machine runs this at ~0.55x the oracle: corpus-03 alone took 915 s
      1_800_000,
    );
  }
});
