export type Release = {
  version: string;
  date: string;
  entries: string[];
};

// Newest first.
export const releases: Release[] = [
  {
    version: "0.2.0",
    date: "2026-08-30",
    entries: [
      "Read Ask answers aloud using an optional local voice, with Read, Replay, and Stop controls",
      "Download, test, switch, and remove Lessac, Norman, or LJSpeech voices in onboarding and Settings",
      "Apple Silicon builds now require macOS 15 or later",
    ],
  },
];

export const APP_VERSION = releases[0]?.version ?? "0.0.0";
