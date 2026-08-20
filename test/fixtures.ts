// The 08.0 oracle: json the rust build dumped for four real recordings. The ports are
// regressed against it rather than against hand-written expectations.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Chunk, Span } from "../src/worker/chunk";
import type { Assigned, Segment } from "../src/worker/merge";
import type { Turn } from "../src/worker/types";

export const CORPUS = ["jfk", "corpus-01", "corpus-02", "corpus-03"] as const;

const root = join(import.meta.dirname, "..", "fixtures");

const read = <T>(name: string, file: string): T =>
  JSON.parse(readFileSync(join(root, name, file), "utf8")) as T;

export interface ChunksFixture {
  max_chunk_ms: number;
  max_gap_ms: number;
  speech_ms: number;
  spans: Span[];
  chunks: Chunk[];
}

export interface TurnsFixture {
  config: { threshold: number; speakers: number | null };
  mic_track: boolean;
  labels: string[];
  turns: Turn[];
  embeddings: number[][];
}

export interface MergedFixture {
  labels: string[];
  segments: Segment[];
  assigned: Assigned[];
}

export const chunksOf = (name: string): ChunksFixture => read(name, "chunks.json");
export const turnsOf = (name: string): TurnsFixture => read(name, "turns.json");
export const mergedOf = (name: string): MergedFixture => read(name, "merged.json");
