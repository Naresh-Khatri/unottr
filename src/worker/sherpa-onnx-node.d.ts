// sherpa-onnx-node ships jsdoc typedefs, not .d.ts. Only the surface we call is declared.

declare module "sherpa-onnx-node" {
  export interface OfflineTtsVitsConfig {
    model: string;
    tokens: string;
    dataDir: string;
  }

  export interface OfflineTtsConfig {
    model: {
      vits: OfflineTtsVitsConfig;
      numThreads?: number;
      provider?: string;
      debug?: boolean;
    };
    maxNumSentences?: number;
  }

  export interface GeneratedAudio {
    samples: Float32Array;
    sampleRate: number;
  }

  export class GenerationConfig {
    constructor(options?: { sid?: number; speed?: number; silenceScale?: number });
  }

  export class OfflineTts {
    static createAsync(config: OfflineTtsConfig): Promise<OfflineTts>;
    readonly numSpeakers: number;
    readonly sampleRate: number;
    generateAsync(options: {
      text: string;
      generationConfig: GenerationConfig;
      enableExternalBuffer?: boolean;
      onProgress?: (info: { samples: Float32Array; progress: number }) => boolean | number | void;
    }): Promise<GeneratedAudio>;
  }

  export interface SpeakerDiarizationSegment {
    /** seconds */
    start: number;
    /** seconds */
    end: number;
    speaker: number;
  }

  export interface FastClusteringConfig {
    /** < 1 switches sherpa from fixed-k to threshold mode. */
    numClusters: number;
    threshold: number;
  }

  export interface EmbeddingConfig {
    model: string;
    numThreads?: number;
    debug?: boolean;
    provider?: string;
  }

  export interface DiarizationConfig {
    segmentation: {
      pyannote: { model: string; windowShiftRatio?: number };
      numThreads?: number;
      debug?: boolean;
      provider?: string;
    };
    embedding: EmbeddingConfig;
    clustering: FastClusteringConfig;
    minDurationOn?: number;
    minDurationOff?: number;
  }

  export class OfflineSpeakerDiarization {
    constructor(config: DiarizationConfig);
    /** Opaque native pointer; only the raw addon accepts it. */
    readonly handle: unknown;
    readonly sampleRate: number;
    process(samples: Float32Array): SpeakerDiarizationSegment[];
    setConfig(config: { clustering: FastClusteringConfig }): void;
  }

  export class OnlineStream {
    acceptWaveform(obj: { samples: Float32Array; sampleRate: number }): void;
    inputFinished(): void;
  }

  export class SpeakerEmbeddingExtractor {
    constructor(config: EmbeddingConfig);
    readonly dim: number;
    createStream(): OnlineStream;
    isReady(stream: OnlineStream): boolean;
    compute(stream: OnlineStream, enableExternalBuffer?: boolean): Float32Array;
  }
}

declare module "sherpa-onnx-node/addon.js" {
  import type { OfflineSpeakerDiarization, SpeakerDiarizationSegment } from "sherpa-onnx-node";

  /**
   * The async twin of `OfflineSpeakerDiarization.process`, reachable only through the raw
   * addon: the js wrapper never exposes it. Runs off the event loop and reports
   * `(done, total)` per segmentation window.
   */
  export function offlineSpeakerDiarizationProcessAsync(
    handle: OfflineSpeakerDiarization["handle"],
    samples: Float32Array,
    onProgress: (done: number, total: number) => number,
  ): Promise<SpeakerDiarizationSegment[]>;
}
