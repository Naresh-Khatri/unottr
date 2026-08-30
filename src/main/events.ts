// Outbound half of the ipc contract (docs/plan/05-ipc-contract.md). Tauri's `app.emit`
// broadcasts to every window; electron has no such thing, so we fan out by hand.

import { BrowserWindow } from "electron";
import type {
  AskProgress,
  BackfillProgress,
  JobDone,
  JobFailed,
  JobProgress,
  IncomingFileProgress,
  ModelDownloadProgress,
  OverviewChanged,
  OverviewProgress,
  ProbeProgress,
  RecordingDiscovered,
  TranscriptChanged,
  TtsEvent,
} from "../shared/ipc";

function emit(event: string, payload: unknown): void {
  // prefixed so a stray renderer listener on a bare name can't collide with electron's own
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(`unottr:${event}`, payload);
  }
}

export const events = {
  jobProgress: (p: JobProgress) => emit("job_progress", p),
  jobDone: (p: JobDone) => emit("job_done", p),
  jobFailed: (p: JobFailed) => emit("job_failed", p),
  recordingDiscovered: (p: RecordingDiscovered) => emit("recording_discovered", p),
  incomingFileProgress: (p: IncomingFileProgress) => emit("incoming_file_progress", p),
  transcriptChanged: (p: TranscriptChanged) => emit("transcript_changed", p),
  modelDownloadProgress: (p: ModelDownloadProgress) => emit("model_download_progress", p),
  backfillProgress: (p: BackfillProgress) => emit("backfill_progress", p),
  probeProgress: (p: ProbeProgress) => emit("probe_progress", p),
  askProgress: (p: AskProgress) => emit("ask_progress", p),
  overviewChanged: (p: OverviewChanged) => emit("overview_changed", p),
  overviewProgress: (p: OverviewProgress) => emit("overview_progress", p),
  ttsEvent: (event: TtsEvent) => emit("tts_event", event),
};
