import { join } from "node:path";
import { utilityProcess, type UtilityProcess } from "electron";
import type { TtsEvent, TtsVoiceId } from "../../shared/ipc";
import type { TtsWorkerReply, TtsWorkerRequest } from "../../tts-worker/protocol";
import { events } from "../events";
import { installedVoicePaths, voiceById, voiceStatus } from "./voice";

class TtsManager {
  private child: UtilityProcess | null = null;
  private warming: Promise<void> | null = null;
  private activeRequest: string | null = null;
  private command = 0;
  private loadedVoiceId: TtsVoiceId | null = null;

  async warm(voiceId: TtsVoiceId): Promise<void> {
    if (this.warming && this.loadedVoiceId === voiceId) return this.warming;
    if (this.child) this.shutdown();
    if (voiceStatus(voiceId).state !== "installed") throw new Error("speech voice is not downloaded");

    this.warming = new Promise<void>((resolve, reject) => {
      const voice = voiceById(voiceId);
      const paths = installedVoicePaths(voice.id);
      const child = utilityProcess.fork(join(__dirname, "tts-worker.cjs"), [], {
        serviceName: "unottr-speech",
        stdio: ["ignore", "ignore", "pipe"],
      });
      this.child = child;
      this.loadedVoiceId = voice.id;
      let ready = false;
      let stderrTail = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderrTail = `${stderrTail}${chunk}`.slice(-4_096);
      });
      child.on("message", (reply: TtsWorkerReply) => {
        if (reply.type === "ready" && !ready) {
          ready = true;
          resolve();
        } else if (reply.type === "error" && !ready) {
          ready = true;
          if (this.child === child) {
            this.child = null;
            this.warming = null;
            this.loadedVoiceId = null;
          }
          child.kill();
          reject(new Error(reply.message));
          return;
        }
        this.handle(reply);
      });
      child.once("spawn", () => child.postMessage({
        type: "warm",
        voice: {
          model: paths.model,
          tokens: paths.tokens,
          data_dir: paths.dataDir,
          threads: voice.threads,
          speaker_id: voice.speakerId,
          speed: voice.speed,
          silence_scale: voice.silenceScale,
        },
      } satisfies TtsWorkerRequest));
      child.once("exit", (code) => {
        const wasCurrent = this.child === child;
        if (wasCurrent) {
          this.child = null;
          this.warming = null;
          this.loadedVoiceId = null;
        }
        if (!ready) reject(new Error(`speech worker exited (${code})`));
        const requestId = wasCurrent ? this.activeRequest : null;
        if (requestId) {
          this.activeRequest = null;
          events.ttsEvent({
            type: "error",
            request_id: requestId,
            message: stderrTail ? "speech worker crashed" : `speech worker exited (${code})`,
          });
        }
      });
    });
    return this.warming;
  }

  async speak(requestId: string, sentences: string[], voiceId: TtsVoiceId): Promise<void> {
    if (this.child && this.loadedVoiceId !== voiceId) this.shutdown();
    const command = ++this.command;
    if (this.activeRequest) this.child?.postMessage({ type: "stop" } satisfies TtsWorkerRequest);
    await this.warm(voiceId);
    if (command !== this.command || !this.child) return;
    this.activeRequest = requestId;
    this.child.postMessage({ type: "speak", request_id: requestId, sentences } satisfies TtsWorkerRequest);
  }

  stop(): void {
    this.command += 1;
    const requestId = this.activeRequest;
    this.activeRequest = null;
    this.child?.postMessage({ type: "stop" } satisfies TtsWorkerRequest);
    if (requestId) events.ttsEvent({ type: "stopped", request_id: requestId });
  }

  shutdown(): void {
    this.command += 1;
    this.activeRequest = null;
    const child = this.child;
    this.child = null;
    this.warming = null;
    this.loadedVoiceId = null;
    if (!child) return;
    child.postMessage({ type: "close" } satisfies TtsWorkerRequest);
    child.kill();
  }

  private handle(reply: TtsWorkerReply): void {
    if (reply.type === "ready") {
      events.ttsEvent({ type: "ready" });
      return;
    }
    if (reply.type === "error") {
      if (reply.request_id === this.activeRequest) this.activeRequest = null;
      events.ttsEvent(reply);
      return;
    }
    if (reply.request_id !== this.activeRequest) return;
    if (reply.type === "done" || reply.type === "stopped") this.activeRequest = null;
    events.ttsEvent(reply as TtsEvent);
  }
}

export const ttsManager = new TtsManager();
