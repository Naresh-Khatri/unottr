import { api, onTtsEvent } from "@/ipc/client";
import type { TtsEvent } from "@/ipc/types";
import { askSpeechSentences } from "@/lib/askSpeechText";

export interface AskSpeechState {
  activeMessageId: number | null;
  lastMessageId: number | null;
  status: "idle" | "loading" | "playing" | "error";
  error: string | null;
  activeSentenceIndex: number | null;
}

interface TimedSentence {
  index: number;
  start: number;
  end: number;
}

class AskSpeechController {
  private state: AskSpeechState = {
    activeMessageId: null,
    lastMessageId: null,
    status: "idle",
    error: null,
    activeSentenceIndex: null,
  };
  private readonly listeners = new Set<(state: AskSpeechState) => void>();
  private context: AudioContext | null = null;
  private requestId: string | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private nextStart = 0;
  private synthesisDone = false;
  private sentenceTimeline: TimedSentence[] = [];
  private trackingFrame: number | null = null;

  constructor() {
    onTtsEvent((event) => this.handle(event));
  }

  snapshot(): AskSpeechState {
    return this.state;
  }

  subscribe(listener: (state: AskSpeechState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  warm(): void {
    void api.ttsWarm().catch(() => {});
  }

  async speak(messageId: number, markdown: string): Promise<void> {
    const sentences = askSpeechSentences(markdown);
    if (sentences.length === 0) return;
    this.stop();

    const requestId = crypto.randomUUID();
    this.requestId = requestId;
    this.synthesisDone = false;
    this.nextStart = 0;
    this.sentenceTimeline = [];
    this.update({
      activeMessageId: messageId,
      lastMessageId: this.state.lastMessageId,
      status: "loading",
      error: null,
      activeSentenceIndex: null,
    });

    try {
      this.context ??= new AudioContext();
      await this.context.resume();
      await api.ttsSpeak({ request_id: requestId, sentences });
    } catch (error) {
      if (this.requestId !== requestId) return;
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  stop(): void {
    const messageId = this.state.activeMessageId;
    this.requestId = null;
    this.synthesisDone = false;
    this.nextStart = 0;
    this.sentenceTimeline = [];
    this.stopTracking();
    for (const source of this.sources) {
      try { source.stop(); } catch { /* already ended */ }
    }
    this.sources.clear();
    if (messageId !== null) {
      this.update({
        activeMessageId: null,
        lastMessageId: messageId,
        status: "idle",
        error: null,
        activeSentenceIndex: null,
      });
    }
    void api.ttsStop().catch(() => {});
  }

  private handle(event: TtsEvent): void {
    if (event.type === "ready" || event.request_id !== this.requestId) return;
    if (event.type === "error") {
      this.fail(event.message);
      return;
    }
    if (event.type === "stopped") {
      this.stop();
      return;
    }
    if (event.type === "done") {
      this.synthesisDone = true;
      this.finishIfSilent();
      return;
    }
    this.schedule(event.samples, event.sample_rate, event.sequence);
  }

  private schedule(samples: Float32Array, sampleRate: number, sequence: number): void {
    if (!this.context || samples.length === 0 || sampleRate <= 0) return;
    const buffer = this.context.createBuffer(1, samples.length, sampleRate);
    buffer.getChannelData(0).set(samples);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    const start = Math.max(this.context.currentTime + 0.02, this.nextStart);
    this.nextStart = start + buffer.duration;
    this.sentenceTimeline.push({ index: sequence, start, end: this.nextStart });
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      this.finishIfSilent();
    };
    source.start(start);
    this.update({ ...this.state, status: "playing", error: null });
    this.startTracking();
  }

  private finishIfSilent(): void {
    if (!this.synthesisDone || this.sources.size > 0 || this.state.activeMessageId === null) return;
    const messageId = this.state.activeMessageId;
    this.requestId = null;
    this.stopTracking();
    this.update({
      activeMessageId: null,
      lastMessageId: messageId,
      status: "idle",
      error: null,
      activeSentenceIndex: null,
    });
  }

  private fail(message: string): void {
    const messageId = this.state.activeMessageId;
    this.requestId = null;
    for (const source of this.sources) {
      try { source.stop(); } catch { /* already ended */ }
    }
    this.sources.clear();
    this.stopTracking();
    this.update({
      activeMessageId: null,
      lastMessageId: messageId ?? this.state.lastMessageId,
      status: "error",
      error: message,
      activeSentenceIndex: null,
    });
  }

  private startTracking(): void {
    if (this.trackingFrame !== null) return;
    const track = () => {
      this.trackingFrame = null;
      if (!this.context || this.requestId === null) return;
      const now = this.context.currentTime;
      const active = this.sentenceTimeline.find((sentence) => now >= sentence.start && now < sentence.end)?.index ?? null;
      if (active !== this.state.activeSentenceIndex) {
        this.update({ ...this.state, activeSentenceIndex: active });
      }
      this.trackingFrame = window.requestAnimationFrame(track);
    };
    this.trackingFrame = window.requestAnimationFrame(track);
  }

  private stopTracking(): void {
    if (this.trackingFrame === null) return;
    window.cancelAnimationFrame(this.trackingFrame);
    this.trackingFrame = null;
  }

  private update(state: AskSpeechState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

export const askSpeech = new AskSpeechController();
