import type {} from "electron";
import { GenerationConfig, OfflineTts } from "sherpa-onnx-node";
import type { TtsWorkerReply, TtsWorkerRequest, TtsWorkerVoice } from "./protocol";

let tts: OfflineTts | null = null;
let voice: TtsWorkerVoice | null = null;
let generation = 0;
let activeRequest: string | null = null;
let work = Promise.resolve();

process.parentPort.on("message", (event) => {
  const request = event.data as TtsWorkerRequest;
  if (request.type === "warm") {
    voice = request.voice;
    work = work.then(() => warm(request.voice)).catch((error) => fail(null, error));
    return;
  }
  if (request.type === "stop") {
    generation += 1;
    const stopped = activeRequest;
    activeRequest = null;
    if (stopped) send({ type: "stopped", request_id: stopped });
    return;
  }
  if (request.type === "close") {
    generation += 1;
    process.exit(0);
  }

  const token = ++generation;
  work = work
    .then(() => speak(request.request_id, request.sentences, token))
    .catch((error) => fail(request.request_id, error));
});

process.on("uncaughtException", (error) => {
  fail(activeRequest, error);
  process.exit(1);
});
process.on("unhandledRejection", (error) => {
  fail(activeRequest, error);
  process.exit(1);
});

async function warm(nextVoice: TtsWorkerVoice): Promise<void> {
  if (tts) {
    send({ type: "ready" });
    return;
  }
  tts = await OfflineTts.createAsync({
    model: {
      vits: {
        model: nextVoice.model,
        tokens: nextVoice.tokens,
        dataDir: nextVoice.data_dir,
      },
      numThreads: nextVoice.threads,
      provider: "cpu",
      debug: false,
    },
    maxNumSentences: 1,
  });
  send({ type: "ready" });
}

async function speak(requestId: string, sentences: string[], token: number): Promise<void> {
  if (!voice) throw new Error("TTS voice was not configured");
  await warm(voice);
  if (!tts || token !== generation) return;

  activeRequest = requestId;
  const generationConfig = new GenerationConfig({
    sid: voice.speaker_id,
    speed: voice.speed,
    silenceScale: voice.silence_scale,
  });

  for (let sequence = 0; sequence < sentences.length; sequence += 1) {
    if (token !== generation) return;
    const audio = await tts.generateAsync({
      text: sentences[sequence],
      generationConfig,
      // Electron utility processes reject N-API external ArrayBuffers. Ask Sherpa to copy
      // the final audio into a regular buffer before the worker sends it to the renderer.
      enableExternalBuffer: false,
      onProgress: () => token === generation,
    });
    if (token !== generation) return;
    send({
      type: "audio",
      request_id: requestId,
      sequence,
      samples: new Float32Array(audio.samples),
      sample_rate: audio.sampleRate,
    });
  }

  if (token === generation) {
    activeRequest = null;
    send({ type: "done", request_id: requestId });
  }
}

function fail(requestId: string | null, error: unknown): void {
  activeRequest = null;
  send({
    type: "error",
    request_id: requestId,
    message: error instanceof Error ? error.message : String(error),
  });
}

function send(reply: TtsWorkerReply): void {
  process.parentPort.postMessage(reply);
}
