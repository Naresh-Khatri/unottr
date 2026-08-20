// The sherpa-onnx side: pyannote segmentation into turns, CAM++ embeddings into clusters.
// Port of crates/unottr-core/src/diarize/engine.rs.
//
// Runs over the whole recording in one pass. Clustering is global — chunking it would let
// the same voice land in different clusters either side of a boundary, which is the one
// mistake diarization cannot recover from.

import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename } from "node:path";
import { OfflineSpeakerDiarization, SpeakerEmbeddingExtractor } from "sherpa-onnx-node";
import { offlineSpeakerDiarizationProcessAsync } from "sherpa-onnx-node/addon.js";
import { err } from "../main/errors";
import { TARGET_SAMPLE_RATE } from "../main/media/types";
import {
  DEFAULT_THRESHOLD,
  FRAGMENT_THRESHOLD,
  agglomerate,
  applyLabels,
  fragmentCount,
  isEmbedded,
  normalize,
  pruneTinySpeakers,
  relabel,
  renumber,
} from "./cluster";
import type { Diarization, Turn } from "./types";

/** Turns shorter than this are dropped; gaps shorter than this do not break a turn. Both
 *  are pyannote's own defaults, in seconds. */
const MIN_DURATION_ON = 0.3;
const MIN_DURATION_OFF = 0.5;

/** Sherpa reports progress over the embedding loop, which is nearly all of the wall clock.
 *  The rest is our own centroid pass. */
const SEGMENT_SHARE = 0.9;

/** Turns used to build one speaker's centroid, longest first. Averaging every turn costs
 *  minutes on a long meeting and moves the centroid by almost nothing. */
const CENTROID_TURNS = 8;

/** Floor on a turn worth embedding on its own. Below ~30 ms the extractor returns non-finite
 *  garbage rather than an error, so stay well clear of the edge. */
const MIN_EMBED_MS = 800;

/** Past this a turn contributes nothing new to its own embedding. */
const MAX_EMBED_MS = 10_000;

export interface Config {
  /** Ignored when `speakers` is set. */
  threshold: number;
  /** Known speaker count. null clusters on `threshold`, which is the normal case — we do
   *  not know how many people were in a meeting. */
  speakers: number | null;
}

export const defaultConfig = (): Config => ({ threshold: DEFAULT_THRESHOLD, speakers: null });

export class Diarizer {
  private constructor(
    private readonly inner: OfflineSpeakerDiarization,
    private readonly embed: SpeakerEmbeddingExtractor,
    private readonly config: Config,
  ) {}

  static load(segmentation: string, embedding: string, config: Config): Diarizer {
    for (const path of [segmentation, embedding]) {
      if (!existsSync(path)) throw err.modelMissing(basename(path));
    }

    try {
      const threads = availableParallelism();
      const inner = new OfflineSpeakerDiarization({
        segmentation: { pyannote: { model: segmentation }, numThreads: threads, debug: false },
        embedding: { model: embedding, numThreads: threads, debug: false },
        clustering: {
          // < 1 is what switches sherpa's clustering from fixed-k to threshold mode; its own
          // default is 4, which would invent or merge speakers silently
          numClusters: config.speakers === null ? -1 : Math.max(1, config.speakers),
          threshold: FRAGMENT_THRESHOLD,
        },
        minDurationOn: MIN_DURATION_ON,
        minDurationOff: MIN_DURATION_OFF,
      });
      const embed = new SpeakerEmbeddingExtractor({
        model: embedding,
        numThreads: threads,
        debug: false,
      });
      return new Diarizer(inner, embed, config);
    } catch (e) {
      throw err.diarize(e instanceof Error ? e.message : String(e));
    }
  }

  get embeddingSize(): number {
    return this.embed.dim;
  }

  /** Diarize a whole recording. `pcm` is 16 kHz mono, the same buffer transcription ran on. */
  async run(
    pcm: Float32Array,
    progress: (pct: number) => void,
    signal?: AbortSignal,
  ): Promise<Diarization> {
    check(signal);
    if (pcm.length === 0) return { turns: [], embeddings: [] };

    const turns = relabel(await this.segment(pcm, progress));
    check(signal);

    // fixed-k: sherpa's own clustering is trustworthy when it knows the count. Unknown count
    // is where its complete-linkage shatters a speaker, so re-cluster its fragments.
    if (this.config.speakers === null) this.recluster(pcm, turns, signal);

    const speakers = fragmentCount(turns);
    const embeddings: Float32Array[] = [];
    for (let s = 0; s < speakers; s++) {
      check(signal);
      embeddings.push(this.centroid(pcm, turns, s));
      progress(SEGMENT_SHARE + ((1 - SEGMENT_SHARE) * (s + 1)) / speakers);
    }

    return { turns, embeddings };
  }

  private async segment(
    pcm: Float32Array,
    progress: (pct: number) => void,
  ): Promise<{ start: number; end: number; speaker: number }[]> {
    try {
      return await offlineSpeakerDiarizationProcessAsync(this.inner.handle, pcm, (done, total) => {
        if (total > 0) progress(SEGMENT_SHARE * clamp01(done / total));
        // sherpa ignores this; there is no way to abort mid-pass
        return 0;
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // a recording with no speech at all is a normal outcome, not a failure
      if (message.includes("No segments found")) return [];
      throw err.diarize(message);
    }
  }

  /**
   * Rejoin the fragments sherpa over-split a speaker into. Each fragment gets a centroid;
   * average-linkage merges those whose voices agree, cut at the merge threshold. Fragments
   * too short to embed are folded into whichever real speaker is nearest in time -- a lone
   * "yeah" should not become its own speaker.
   */
  private recluster(pcm: Float32Array, turns: Turn[], signal?: AbortSignal): void {
    const frags = fragmentCount(turns);
    if (frags < 2) return;

    const centroids: Float32Array[] = [];
    for (let f = 0; f < frags; f++) {
      check(signal);
      centroids.push(this.centroid(pcm, turns, f));
    }

    // a fragment whose turns were all too short embeds to nothing; cluster only the rest
    const strong: number[] = [];
    for (let i = 0; i < frags; i++) if (isEmbedded(centroids[i])) strong.push(i);
    if (strong.length === 0) return;

    const labels = agglomerate(
      strong.map((i) => centroids[i]),
      this.config.threshold,
    );
    const speakerOf: (number | null)[] = new Array(frags).fill(null);
    strong.forEach((f, k) => {
      speakerOf[f] = labels[k];
    });

    applyLabels(turns, speakerOf);
    pruneTinySpeakers(turns);
    renumber(turns);
  }

  /**
   * One speaker's embedding: the mean of their longest turns, re-normalised. Falls back to
   * their whole speech concatenated when every turn is too short to embed alone.
   */
  centroid(pcm: Float32Array, turns: Turn[], speaker: number): Float32Array {
    const mine = turns
      .filter((t) => t.speaker === speaker)
      .sort((a, b) => b.end_ms - b.start_ms - (a.end_ms - a.start_ms));

    const sum = new Float32Array(this.embed.dim);
    let used = 0;
    for (const turn of mine.slice(0, CENTROID_TURNS)) {
      // sorted by length, so everything after is shorter too
      if (turn.end_ms - turn.start_ms < MIN_EMBED_MS) break;
      const endMs = Math.min(turn.end_ms, turn.start_ms + MAX_EMBED_MS);
      try {
        const v = normalize(this.compute(slice(pcm, turn.start_ms, endMs)));
        for (let i = 0; i < sum.length; i++) sum[i] += v[i];
        used++;
      } catch {
        // one unembeddable turn is not a failed recording; the others still make a centroid
      }
    }
    if (used > 0) return normalize(sum);

    let joined: Float32Array = new Float32Array(0);
    for (const turn of mine) {
      joined = concat(joined, slice(pcm, turn.start_ms, turn.end_ms));
      if (joined.length >= samplesAt(MAX_EMBED_MS)) break;
    }
    // handed over at whatever length it is, exactly as the rust build does. padding it out to
    // MIN_EMBED_MS with silence moved these centroids enough to split a corpus-02 speaker in
    // two. below ~30 ms the extractor returns non-finite garbage, which isEmbedded rejects.
    try {
      return normalize(this.compute(joined));
    } catch (e) {
      throw err.diarize(`speaker ${speaker}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private compute(samples: Float32Array): Float32Array {
    const stream = this.embed.createStream();
    stream.acceptWaveform({ samples, sampleRate: TARGET_SAMPLE_RATE });
    stream.inputFinished();
    return this.embed.compute(stream);
  }
}

const check = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw err.cancelled();
};

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

const samplesAt = (ms: number): number => Math.floor((ms * TARGET_SAMPLE_RATE) / 1000);

function slice(pcm: Float32Array, startMs: number, endMs: number): Float32Array {
  const lo = Math.min(samplesAt(startMs), pcm.length);
  const hi = Math.max(lo, Math.min(samplesAt(endMs), pcm.length));
  return pcm.subarray(lo, hi);
}

function concat(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
