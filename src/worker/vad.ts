// Silero vad over the whole recording. Port of `detect_speech` in
// crates/unottr-core/src/transcribe/chunk.rs.

import { basename } from "node:path";
import { initWhisperVad } from "@fugood/whisper.node";
import { err } from "../main/errors";
import { toArrayBuffer } from "../main/media/pcm";
import { MAX_CHUNK_MS, type Span } from "./chunk";
import { VARIANT } from "./whisper";

/**
 * @param pcm whole-file 16 kHz mono s16le — `detectSpeechData` reads raw buffers as 16-bit
 *   pcm; handing it float samples returns zero segments rather than failing.
 */
export async function detectSpeech(pcm: Buffer, model: string): Promise<Span[]> {
  const ctx = await initWhisperVad(
    {
      filePath: model,
      // the silero graph aborts on the vulkan backend ("pre-allocated tensor in a buffer that
      // cannot run the operation"). <1 MB, ~1 s on cpu, so there is nothing to win here.
      useGpu: false,
    },
    // naming the variant is not optional: it is the only prebuild installed
    VARIANT,
    // bad magic, truncated file, unreadable -- all the same fix for the user
  ).catch(() => {
    throw err.modelMissing(basename(model));
  });

  try {
    const segments = await ctx.detectSpeechData(toArrayBuffer(pcm), {
      // makes the vad itself break up a monologue, so `pack` rarely has to hard-split
      maxSpeechDurationS: MAX_CHUNK_MS / 1000,
    });
    // vad timestamps are centiseconds (unlike transcription's, which are already ms)
    return segments
      .map((s) => ({ start_ms: Math.max(0, s.t0) * 10, end_ms: Math.max(0, s.t1) * 10 }))
      .filter((s) => s.end_ms > s.start_ms);
  } catch (e) {
    throw err.whisper(e instanceof Error ? e.message : String(e));
  } finally {
    await ctx.release().catch(() => {});
  }
}
