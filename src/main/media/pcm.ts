// Port of the pcm maths in crates/unottr-core/src/media/mod.rs.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { err } from "../errors";
import { TARGET_SAMPLE_RATE } from "./types";

const BYTES_PER_SAMPLE = 2;

/** Bytes of 16 kHz mono s16le pcm for a given duration. */
export const pcmBytesForMs = (durationMs: number): number =>
  Math.floor((durationMs * TARGET_SAMPLE_RATE * BYTES_PER_SAMPLE) / 1000);

/** Duration represented by a pcm file of this size. */
export const pcmDurationMs = (bytes: number): number =>
  Math.floor((bytes * 1000) / (TARGET_SAMPLE_RATE * BYTES_PER_SAMPLE));

/**
 * Load a whole pcm file as the f32 samples whisper wants. ~230 MB per hour of audio in
 * memory; the alternative is decoding the same bytes once per chunk.
 */
export function readPcmF32(path: string): Float32Array {
  return decodeS16(read(path));
}

/** Same conversion for callers that already hold the bytes — the vad wants them either way. */
export function decodeS16(buf: Buffer): Float32Array {
  const n = buf.length >> 1; // trailing odd byte is dropped, not misread as half a sample
  const out = new Float32Array(n);
  // an Int16Array view needs an even byteOffset, which a pooled Buffer does not guarantee
  if (buf.byteOffset % 2 === 0) {
    const src = new Int16Array(buf.buffer, buf.byteOffset, n);
    for (let i = 0; i < n; i++) out[i] = src[i] / 32768;
  } else {
    for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  }
  return out;
}

/**
 * Hand a pcm buffer to a native addon. Node may return a pooled Buffer, so the whole
 * `ArrayBuffer` behind it is almost never the region we mean.
 */
export const toArrayBuffer = (b: Buffer): ArrayBuffer =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

/**
 * Sum several pcm tracks into one. A two-track recording still needs a single mix for
 * transcription — whisper has to hear the whole conversation — while diarization keeps the
 * tracks apart. Tracks of unequal length are padded with silence.
 *
 * The sum is scaled down if it would clip; distortion costs more accuracy than the few dB.
 */
export function mixPcm(inputs: string[], out: string): void {
  let sum = new Int32Array(0);
  for (const path of inputs) {
    const buf = read(path);
    const n = buf.length >> 1;
    if (n > sum.length) {
      const grown = new Int32Array(n);
      grown.set(sum);
      sum = grown;
    }
    for (let i = 0; i < n; i++) sum[i] += buf.readInt16LE(i * 2);
  }

  let peak = 0;
  for (const s of sum) peak = Math.max(peak, Math.abs(s));
  const gain = 32767 / Math.max(peak, 32767);

  const raw = Buffer.allocUnsafe(sum.length * BYTES_PER_SAMPLE);
  for (let i = 0; i < sum.length; i++) {
    const scaled = roundHalfAwayFromZero(sum[i] * gain);
    raw.writeInt16LE(Math.min(32767, Math.max(-32768, scaled)), i * BYTES_PER_SAMPLE);
  }

  try {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, raw);
  } catch (e) {
    throw err.io(out, e);
  }
}

// rust's f64::round is half-away-from-zero; Math.round breaks ties toward +infinity
const roundHalfAwayFromZero = (x: number): number => Math.sign(x) * Math.round(Math.abs(x));

function read(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (e) {
    throw err.io(path, e);
  }
}
