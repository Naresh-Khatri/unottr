// Port of crates/unottr-core/src/transcribe/model.rs and diarize/model.rs. Sizes and
// hashes are the files this project was developed against — a mismatch means upstream
// re-uploaded, not that the user is unlucky.

/**
 * A downloadable model file. `size` and `sha256` are both checked: size catches a truncated
 * download cheaply, sha256 catches a corrupt one.
 */
export interface ModelSpec {
  name: string;
  /** Filename in the store. Distinctive on purpose — upstream `model.onnx` would collide. */
  file: string;
  baseUrl: string;
  /** Path under `baseUrl`, which is not always what we want to call it on disk. */
  remote: string;
  size: number;
  sha256: string;
}

export const url = (spec: ModelSpec): string => `${spec.baseUrl}/${spec.remote}`;

const HF_WHISPER = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
const HF_VAD = "https://huggingface.co/ggml-org/whisper-vad/resolve/main";
const HF_SEGMENTATION =
  "https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main";
const HF_EMBEDDING = "https://huggingface.co/csukuangfj/speaker-embedding-models/resolve/main";

/** Transcription models, largest first. */
export const WHISPER: ModelSpec[] = [
  {
    name: "large-v3-turbo",
    file: "ggml-large-v3-turbo-q5_0.bin",
    baseUrl: HF_WHISPER,
    remote: "ggml-large-v3-turbo-q5_0.bin",
    size: 574_041_195,
    sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
  },
  {
    name: "medium",
    file: "ggml-medium-q5_0.bin",
    baseUrl: HF_WHISPER,
    remote: "ggml-medium-q5_0.bin",
    size: 539_212_467,
    sha256: "19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f",
  },
  {
    name: "small",
    file: "ggml-small-q5_1.bin",
    baseUrl: HF_WHISPER,
    remote: "ggml-small-q5_1.bin",
    size: 190_085_487,
    sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
  },
  {
    name: "base.en",
    file: "ggml-base.en.bin",
    baseUrl: HF_WHISPER,
    remote: "ggml-base.en.bin",
    size: 147_964_211,
    sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
  },
];

/** Silero v5 for the standalone VAD. Small enough that we always fetch it. */
export const VAD: ModelSpec = {
  name: "silero-v5.1.2",
  file: "ggml-silero-v5.1.2.bin",
  baseUrl: HF_VAD,
  remote: "ggml-silero-v5.1.2.bin",
  size: 885_098,
  sha256: "29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf",
};

/** Speech/overlap segmentation. */
export const SEGMENTATION: ModelSpec = {
  name: "pyannote-segmentation-3.0",
  file: "sherpa-pyannote-segmentation-3.0.onnx",
  baseUrl: HF_SEGMENTATION,
  remote: "model.onnx",
  size: 5_992_913,
  sha256: "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079",
};

/**
 * Speaker embedding models, default first. The default is trained on Chinese *and* English;
 * the corpus is not English-only, and an embedder that has only ever heard one language is
 * the wrong thing to bet speaker identity on.
 */
export const EMBEDDINGS: ModelSpec[] = [
  {
    name: "campplus-zh-en",
    file: "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
    baseUrl: HF_EMBEDDING,
    remote: "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
    size: 28_281_164,
    sha256: "aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2",
  },
  {
    name: "campplus-en",
    file: "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx",
    baseUrl: HF_EMBEDDING,
    remote: "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx",
    size: 29_596_978,
    sha256: "357a834f702b80161e5b981182c038e18553c1f2ca752ed6cec2052365d4129b",
  },
  {
    name: "wespeaker-campplus",
    file: "wespeaker_en_voxceleb_CAM++.onnx",
    baseUrl: HF_EMBEDDING,
    remote: "wespeaker_en_voxceleb_CAM++.onnx",
    size: 29_292_684,
    sha256: "c46fad10b5f81e1aa4a60c162714208577093655076c5450f8c469e522ec54ef",
  },
];

export const findWhisper = (name: string): ModelSpec | undefined =>
  WHISPER.find((m) => m.name === name);

export const findEmbedding = (name: string): ModelSpec | undefined =>
  EMBEDDINGS.find((m) => m.name === name);

export const defaultEmbedding = (): ModelSpec => EMBEDDINGS[0];

/**
 * `large-v3-turbo` measures 0.8x realtime on 12 cpu threads — slower than the meeting
 * itself — so the cpu path drops two sizes. See the phase 02 spike verdict.
 */
export function defaultWhisper(gpu: boolean): ModelSpec {
  const spec = findWhisper(gpu ? "large-v3-turbo" : "small");
  if (!spec) throw new Error("registry always carries the defaults");
  return spec;
}

/**
 * What `auto` settles for, best first, when the ideal tier is not on disk — a gpu box wants
 * turbo but onboarding downloads small, and failing the job over that helps nobody. Falling
 * *up* is the cpu path's last resort only: turbo on cpu is slower than the meeting.
 */
export function whisperPreference(gpu: boolean): ModelSpec[] {
  const order = gpu
    ? ["large-v3-turbo", "medium", "small", "base.en"]
    : ["small", "base.en", "medium", "large-v3-turbo"];
  return order.map(findWhisper).filter((m): m is ModelSpec => m !== undefined);
}

/**
 * `turbo`/`medium`/`small` are the three tiers the settings screen offers; `base.en` stays
 * cli-only. `undefined` (including "auto") defers to `defaultWhisper`.
 */
export function tierToModelName(tier: string): string | undefined {
  switch (tier) {
    case "turbo":
      return "large-v3-turbo";
    case "medium":
      return "medium";
    case "small":
      return "small";
    default:
      return undefined;
  }
}

export function modelNameToTier(name: string): string {
  switch (name) {
    case "large-v3-turbo":
      return "turbo";
    case "medium":
      return "medium";
    case "small":
      return "small";
    default:
      return "auto";
  }
}
