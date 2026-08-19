// Zero-backend mock of the IPC surface, matching docs/plan/05-ipc-contract.md.
// Lets Track B build the whole UI before the Rust commands exist. Swap `invoke`/`listen`
// for @tauri-apps/api once phase 04/05 land — call shapes are identical.

import type {
  JobProgress,
  RecordingDetail,
  RecordingFilter,
  RecordingSort,
  RecordingSummary,
  SearchHit,
  Segment,
  Speaker,
  WatchFolder,
} from "./types";

const speakers9001: Speaker[] = [
  { id: 9101, recording_id: 9001, label: "Speaker 1", display_name: "Priya" },
  { id: 9102, recording_id: 9001, label: "Speaker 2", display_name: null },
];

const segments9001: Segment[] = [
  { id: 1, chunk_idx: 0, start_ms: 1360, end_ms: 4200,
    text: "Yeah, let's start with the quarterly roadmap review.",
    words: [
      { text: "Yeah,", start_ms: 1360, end_ms: 1900, p: 0.93 },
      { text: "let's", start_ms: 2100, end_ms: 2600, p: 0.9 },
    ], speaker_id: 9101, split_of: null },
  { id: 2, chunk_idx: 0, start_ms: 4200, end_ms: 7800,
    text: "Sounds good, I pulled the numbers this morning.",
    words: [], speaker_id: 9102, split_of: null },
  { id: 3, chunk_idx: 1, start_ms: 7800, end_ms: 11200,
    text: "Great, walk me through the search latency first.",
    words: [], speaker_id: 9101, split_of: null },
  { id: 4, chunk_idx: 1, start_ms: 11200, end_ms: 13000,
    text: "(crosstalk)", words: [], speaker_id: null, split_of: null },
];

const recordings: RecordingSummary[] = [
  { id: 9001, path: "/home/naresh/fixtures/2025-10-06 roadmap-review.mp4",
    filename: "2025-10-06 roadmap-review.mp4", recorded_at: 1759754411,
    duration_ms: 2130000, status: "done", stage_detail: null, error: null,
    speaker_count: 2, available: true, has_video: true },
  { id: 9002, path: "/home/naresh/fixtures/2026-08-18 standup.mp4",
    filename: "2026-08-18 standup.mp4", recorded_at: 1765000332,
    duration_ms: 1980000, status: "transcribing", stage_detail: "chunk 12/44",
    error: null, speaker_count: 0, available: true, has_video: true },
  { id: 9003, path: "/home/naresh/fixtures/2025-10-12 interrupted.mp4",
    filename: "2025-10-12 interrupted.mp4", recorded_at: 1760276883,
    duration_ms: null, status: "failed", stage_detail: null, error: "Truncated",
    speaker_count: 0, available: false, has_video: false },
];

let folders: WatchFolder[] = [
  { id: 1, path: "/home/naresh", track_rule: "auto", enabled: true },
];

const wait = <T>(v: T, ms = 120): Promise<T> =>
  new Promise((r) => setTimeout(() => r(v), ms));

export const mockCommands = {
  list_recordings(filter?: RecordingFilter, sort?: RecordingSort) {
    let rows = recordings.slice();
    if (filter?.status) rows = rows.filter((r) => r.status === filter.status);
    if (filter?.available !== undefined)
      rows = rows.filter((r) => r.available === filter.available);
    if (sort) {
      const dir = sort.dir === "asc" ? 1 : -1;
      rows.sort((a, b) => {
        const av = a[sort.by] ?? 0, bv = b[sort.by] ?? 0;
        return av < bv ? -dir : av > bv ? dir : 0;
      });
    }
    return wait(rows);
  },
  get_recording(id: number): Promise<RecordingDetail> {
    const summary = recordings.find((r) => r.id === id)!;
    return wait({
      recording: { ...summary, container: "mov,mp4,m4a" },
      segments: id === 9001 ? segments9001 : [],
      speakers: id === 9001 ? speakers9001 : [],
    });
  },
  search(query: string): Promise<SearchHit[]> {
    const q = query.toLowerCase();
    const hits = segments9001
      .filter((s) => s.text.toLowerCase().includes(q))
      .map((s) => ({
        recording_id: 9001, filename: recordings[0].filename,
        segment_id: s.id, start_ms: s.start_ms,
        snippet: s.text.replace(new RegExp(`(${query})`, "ig"), "<b>$1</b>"),
      }));
    return wait(hits);
  },
  rename_speaker(speaker_id: number, name: string) {
    const s = speakers9001.find((x) => x.id === speaker_id);
    if (s) s.display_name = name || null;
    return wait(undefined);
  },
  retry_job: (_id: number) => wait(undefined),
  add_watch_folder(path: string) {
    const f = { id: folders.length + 1, path, track_rule: "auto", enabled: true };
    folders.push(f);
    return wait(f);
  },
  remove_watch_folder(id: number) {
    folders = folders.filter((f) => f.id !== id);
    return wait(undefined);
  },
  list_watch_folders: () => wait(folders.slice()),
  start_backfill: (_folderId: number) => wait(undefined),
};

// Drives a fake job_progress stream for recording 9002 so the live progress bar can be
// built before a real worker emits anything. Returns an unlisten fn like tauri's listen.
export function mockJobProgress(cb: (p: JobProgress) => void): () => void {
  let pct = 12 / 44;
  const t = setInterval(() => {
    pct = Math.min(1, pct + 0.02);
    cb({ recording_id: 9002, stage: "transcribing", pct });
    if (pct >= 1) clearInterval(t);
  }, 500);
  return () => clearInterval(t);
}
