// The wire between main and the compute worker. Structured clone carries all of it, so
// Float32Array embeddings survive as themselves.
//
// The split follows one rule: the worker never touches sqlite. Anything the database has to
// know arrives as a message and main writes it — which is also what makes every `chunk`
// message a resume checkpoint.

import type { ErrorDetail } from "../main/errors";
import type { Resolved } from "../shared/ipc";
import type { Chunk } from "./chunk";
import type { Config } from "./diarize";
import type { Assigned, Segment } from "./merge";
import type { Options, Utterance } from "./whisper";

export interface TranscribeJob {
  pcm: string;
  model: string;
  vad_model: string;
  device: Resolved;
  options: Options;
  /** First chunk to run. Main derived it from `last_chunk_idx` before dispatching. */
  from: number;
}

export interface DiarizeJob {
  /** The track to cluster. With `mic_pcm` set this is the desktop track. */
  pcm: string;
  mic_pcm: string | null;
  segmentation: string;
  embedding: string;
  /** Only read on the mic path. */
  vad_model: string;
  config: Config;
  /** Regrouped by `COALESCE(split_of, id)`; main keeps the row ids it maps back onto. */
  segments: Segment[];
}

export type Request =
  | { type: "transcribe"; job: TranscribeJob }
  | { type: "diarize"; job: DiarizeJob }
  | { type: "cancel" };

export type Reply =
  /** The chunk plan, before any of it runs. Main turns `idx` into a progress fraction. */
  | { type: "plan"; chunks: Chunk[] }
  /** Persist-then-checkpoint: everything up to and including `idx` is done. */
  | { type: "chunk"; idx: number; utterances: Utterance[] }
  | { type: "progress"; pct: number }
  | { type: "transcribed" }
  | { type: "diarized"; labels: string[]; embeddings: Float32Array[]; assigned: Assigned[] }
  | { type: "failed"; error: ErrorDetail };
