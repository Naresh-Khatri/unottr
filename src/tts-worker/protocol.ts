export interface TtsWorkerVoice {
  model: string;
  tokens: string;
  data_dir: string;
  threads: number;
  speaker_id: number;
  speed: number;
  silence_scale: number;
}

export type TtsWorkerRequest =
  | { type: "warm"; voice: TtsWorkerVoice }
  | { type: "speak"; request_id: string; sentences: string[] }
  | { type: "stop" }
  | { type: "close" };

export type TtsWorkerReply =
  | { type: "ready" }
  | { type: "audio"; request_id: string; sequence: number; samples: Float32Array; sample_rate: number }
  | { type: "done"; request_id: string }
  | { type: "stopped"; request_id: string }
  | { type: "error"; request_id: string | null; message: string };
