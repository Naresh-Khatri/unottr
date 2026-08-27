// Port of crates/unottr-core/src/transcribe/engine.rs. One loaded model per recording —
// building it costs seconds plus vram, running a chunk costs neither.

import { availableParallelism } from "node:os";
import { basename } from "node:path";
import { initWhisper, type WhisperContext } from "@fugood/whisper.node";
import { err } from "../main/errors";
import { toArrayBuffer } from "../main/media/pcm";
import type { Resolved } from "../shared/ipc";
import { WHISPER_VARIANT } from "./native-backend";
import { isOomMessage } from "./whisper-errors";

export const VARIANT = WHISPER_VARIANT;

/** Whisper keeps talking past a full stop only when it hears no boundary at all. */
const MAX_UTTERANCE_MS = 15_000;

export interface Options {
  /** null = let whisper detect. Detection runs on the first chunk, so a quiet opening can
   *  get it wrong; that is why the override exists. */
  language: string | null;
  threads: number;
  translate: boolean;
}

export interface Word {
  text: string;
  start_ms: number;
  end_ms: number;
  /** No token probabilities cross this addon's api, so it is always null. See 08.4. */
  p: number | null;
}

/** One transcribed span of speech, timestamps relative to the samples passed in. */
export interface Utterance {
  start_ms: number;
  end_ms: number;
  text: string;
  words: Word[];
}

export const defaultThreads = (): number => availableParallelism();

export const defaultOptions = (): Options => ({
  language: null,
  threads: defaultThreads(),
  translate: false,
});

/** Whisper times every chunk from zero; the db stores absolute times. */
export function shift(u: Utterance, ms: number): Utterance {
  return {
    start_ms: u.start_ms + ms,
    end_ms: u.end_ms + ms,
    text: u.text,
    words: u.words.map((w) => ({ ...w, start_ms: w.start_ms + ms, end_ms: w.end_ms + ms })),
  };
}

export class Transcriber {
  private constructor(
    private readonly ctx: WhisperContext,
    readonly device: Resolved,
    private readonly opts: Options,
  ) {}

  static async load(model: string, device: Resolved, opts: Options): Promise<Transcriber> {
    const ctx = await initWhisper({ filePath: model, useGpu: device === "gpu" }, VARIANT).catch(
      // model load allocates Metal buffers; OOM can happen before the first chunk
      (e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        if (device === "gpu" && isOomMessage(message)) throw err.gpuOom();
        throw err.modelMissing(basename(model));
      },
    );
    return new Transcriber(ctx, device, opts);
  }

  /**
   * Transcribe one chunk of 16 kHz mono s16le pcm. Returns timestamps relative to `pcm`;
   * the caller adds the chunk offset.
   *
   * `maxLen: 1` is what buys word timestamps: the addon exposes segments only, never
   * tokens, so a segment per word is the only granularity we can read back. The sentences
   * are rebuilt from those words here rather than in a second decoding pass.
   */
  async run(pcm: Buffer, signal?: AbortSignal): Promise<Utterance[]> {
    if (signal?.aborted) throw err.cancelled();

    const job = this.ctx.transcribeData(toArrayBuffer(pcm), {
      language: this.opts.language ?? "auto",
      translate: this.opts.translate,
      maxThreads: this.opts.threads,
      tokenTimestamps: true,
      maxLen: 1,
      wordThold: 0.01,
      bestOf: 1,
      // the addon has no `no_context`; an empty text context is the same thing, and it is
      // what makes a resumed run reproduce an uninterrupted one
      maxContext: 0,
    });

    const stop = () => void job.stop();
    signal?.addEventListener("abort", stop, { once: true });
    let result;
    try {
      result = await job.promise;
    } catch (e) {
      throw this.whisperError(e instanceof Error ? e.message : String(e));
    } finally {
      signal?.removeEventListener("abort", stop);
    }
    if (result.isAborted) throw err.cancelled();

    return utterances(mergeWords(result.segments));
  }

  async release(): Promise<void> {
    await this.ctx.release().catch(() => {});
  }

  /**
   * ggml surfaces one flat string for every encode/decode failure — there is no distinct
   * OOM variant to match on. A vulkan allocation failure reliably mentions one of the
   * needles below and only ever happens on the gpu path, so a cpu failure cannot be
   * misread as OOM.
   */
  private whisperError(message: string): Error {
    return this.device === "gpu" && isOomMessage(message) ? err.gpuOom() : err.whisper(message);
  }
}

/**
 * `maxLen: 1` splits on token boundaries, not word boundaries: punctuation and the odd
 * sub-word piece arrive without a leading space. Same rule as the rust `merge_words` — a
 * leading space starts a real word, anything else glues onto the one before.
 */
export function mergeWords(pieces: { text: string; t0: number; t1: number }[]): Word[] {
  const words: Word[] = [];
  for (const piece of pieces) {
    if (!piece.text.trim()) continue;
    if (piece.text.startsWith(" ") || words.length === 0) {
      words.push({
        text: piece.text.trimStart(),
        start_ms: Math.max(0, piece.t0),
        end_ms: Math.max(0, piece.t1),
        p: null,
      });
    } else {
      const last = words[words.length - 1];
      last.text += piece.text;
      last.end_ms = Math.max(last.end_ms, Math.max(0, piece.t1));
    }
  }
  // token timestamps can invert on the odd token; a zero-length word beats a negative one
  for (const w of words) w.end_ms = Math.max(w.end_ms, w.start_ms);
  return words;
}

/**
 * Rebuild whisper's own segmentation from the words. Sentence-final punctuation is the
 * boundary; `MAX_UTTERANCE_MS` catches speech that never gets any, and the chunker has
 * already removed every silence longer than `MAX_GAP_MS`, so no pause rule is needed.
 */
export function utterances(words: Word[]): Utterance[] {
  const out: Utterance[] = [];
  let open: Word[] = [];

  const close = () => {
    if (open.length === 0) return;
    out.push({
      start_ms: open[0].start_ms,
      end_ms: open[open.length - 1].end_ms,
      text: open.map((w) => w.text).join(" "),
      words: open,
    });
    open = [];
  };

  for (const word of words) {
    open.push(word);
    const ends = /[.!?…](["')\]]|\p{Pf})?$/u.test(word.text);
    if (ends || word.end_ms - open[0].start_ms >= MAX_UTTERANCE_MS) close();
  }
  close();
  return out;
}
