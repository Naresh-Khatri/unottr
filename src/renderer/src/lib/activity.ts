import type { JobPhase, Status } from "@/ipc/types";
import { durationLabel } from "@/lib/format";

export interface JobActivityView {
  label: string;
  detail: string | null;
  indeterminate: boolean;
}

const STAGE: Record<Status, string> = {
  discovered: "Waiting",
  probing: "Reading recording",
  extracting: "Extracting audio",
  transcribing: "Transcribing",
  diarizing: "Identifying speakers",
  merging: "Finishing",
  done: "Done",
  failed: "Failed",
};

const PHASE: Record<Exclude<JobPhase, null | "queued">, JobActivityView> = {
  waiting_for_source: {
    label: "Waiting for recording to finish",
    detail: "Processing resumes after the file stops changing.",
    indeterminate: false,
  },
  generating_previews: {
    label: "Creating video previews",
    detail: "Preparing the frames used while browsing and scrubbing.",
    indeterminate: false,
  },
  preparing_audio: {
    label: "Preparing audio",
    detail: "Decoding the recording before speaker analysis.",
    indeterminate: false,
  },
  mixing_tracks: {
    label: "Mixing audio tracks",
    detail: "Combining microphone and system audio for transcription.",
    indeterminate: true,
  },
  connecting_model: {
    label: "Connecting for model download",
    detail: "This only happens when a required local model is missing.",
    indeterminate: true,
  },
  downloading_model: {
    label: "Downloading required model",
    detail: "Processing continues as soon as the local model is ready.",
    indeterminate: false,
  },
  verifying_model: {
    label: "Verifying model",
    detail: "Checking the downloaded file before using it.",
    indeterminate: true,
  },
  detecting_speech: {
    label: "Detecting speech",
    detail: null,
    indeterminate: true,
  },
  detecting_mic_speech: {
    label: "Finding your microphone turns",
    detail: "Scanning the separate microphone track before speaker matching.",
    indeterminate: true,
  },
  retrying_on_cpu: {
    label: "Retrying on CPU",
    detail: "The GPU pass failed. Work is continuing with the slower fallback.",
    indeterminate: true,
  },
  retrying_with_smaller_model: {
    label: "Retrying with a smaller model",
    detail: "The first model ran out of GPU memory.",
    indeterminate: true,
  },
  finishing: {
    label: "Saving transcript changes",
    detail: "Writing speakers, terminology, and search data.",
    indeterminate: true,
  },
};

export function jobActivity(
  status: Status,
  phase: JobPhase | undefined,
  mode: "full" | "transcribe" | "diarize" = "full",
  durationMs: number | null = null,
): JobActivityView {
  if (phase === "queued") {
    const requested = mode === "transcribe"
      ? "retranscription"
      : mode === "diarize" ? "speaker analysis" : "processing";
    return {
      label: "Waiting to start",
      detail: `The ${requested} is queued behind another recording.`,
      indeterminate: true,
    };
  }
  if (phase) {
    const view = PHASE[phase];
    if (phase === "detecting_speech" && durationMs !== null) {
      return {
        ...view,
        detail: `Scanning ${durationLabel(durationMs)} of audio before transcription.`,
      };
    }
    return view;
  }
  if (mode === "transcribe" && status === "transcribing") {
    return { label: "Retranscribing", detail: null, indeterminate: false };
  }
  if (mode === "diarize" && status === "diarizing") {
    return { label: "Identifying speakers", detail: null, indeterminate: false };
  }
  return { label: STAGE[status], detail: null, indeterminate: status === "probing" };
}

export const modelPhaseLabel = (phase: string): string => {
  switch (phase) {
    case "connecting": return "Connecting";
    case "downloading": return "Downloading";
    case "verifying": return "Verifying download";
    case "installing": return "Installing";
    case "done": return "Ready";
    default: return "Preparing";
  }
};

const JOB_PHASES = new Set<Exclude<JobPhase, null>>([
  "queued",
  "waiting_for_source",
  "generating_previews",
  "preparing_audio",
  "mixing_tracks",
  "connecting_model",
  "downloading_model",
  "verifying_model",
  "detecting_speech",
  "detecting_mic_speech",
  "retrying_on_cpu",
  "retrying_with_smaller_model",
  "finishing",
]);

export const jobPhaseOf = (value: string | null | undefined): JobPhase =>
  value && JOB_PHASES.has(value as Exclude<JobPhase, null>)
    ? value as Exclude<JobPhase, null>
    : null;
