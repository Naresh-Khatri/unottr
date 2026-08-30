import type { TtsVoiceId } from "@/ipc/types";

interface VoicePresentation {
  tone: string;
  previewLine: string;
  colorFrom: string;
  colorTo: string;
}

const VOICE_PRESENTATION: Record<TtsVoiceId, VoicePresentation> = {
  "en_US-norman-medium": {
    tone: "Deep · steady · composed",
    previewLine: "Take your time. I'll walk through the answer in a calm, steady way.",
    colorFrom: "#20c7b7",
    colorTo: "#165f7a",
  },
  "en_US-ljspeech-medium": {
    tone: "Bright · crisp · direct",
    previewLine: "Here's the answer, clear and straight to the point. Let's get started.",
    colorFrom: "#5ad9ff",
    colorTo: "#3158d6",
  },
  "en_US-lessac-medium": {
    tone: "Clear · balanced · natural",
    previewLine: "Hello. I'll keep your answers clear, natural, and easy to follow.",
    colorFrom: "#f58f7c",
    colorTo: "#8b45d6",
  },
  "en_US-kristin-medium": {
    tone: "Warm · clear · conversational",
    previewLine: "Hi there. Let's talk through this together and make it feel simple.",
    colorFrom: "#ff9b76",
    colorTo: "#d94d9b",
  },
  "en_US-amy-medium": {
    tone: "Friendly · light · relaxed",
    previewLine: "Hey, I'm ready when you are. Let's make this quick and easy.",
    colorFrom: "#a7d96f",
    colorTo: "#357a43",
  },
  "en_GB-cori-medium": {
    tone: "Smooth · measured · British",
    previewLine: "Hello. I'll guide you through the answer at an even, thoughtful pace.",
    colorFrom: "#f6c56d",
    colorTo: "#a85a2d",
  },
  "en_GB-alan-medium": {
    tone: "Grounded · calm · British",
    previewLine: "Right, let's take this one step at a time and keep things clear.",
    colorFrom: "#7f8cff",
    colorTo: "#4037a5",
  },
};

export function voicePresentation(voiceId: TtsVoiceId): VoicePresentation {
  return VOICE_PRESENTATION[voiceId];
}
