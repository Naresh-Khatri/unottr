# Phase 05 — Frozen IPC & type contract

**Purpose:** let Track B (UI shell) build in parallel with Tracks A/C. Everything here is
derivable from the phase-00 schema and the phase-02/03 core structs, both of which are
frozen. The UI builds against these shapes; when the live worker lands (phase 04) only the
event *sources* get wired — the shapes do not move.

**Owns nothing new.** This is a projection of existing types. If the schema changes, this
doc changes with it, and every change is a breaking change to the frontend — so freeze it.

---

## Status enum (UI-facing)

Phase 04 owns the real state machine. The provisional CLI strings currently in the db
(`pending`, `transcribed`, `diarized`) are **not** the contract. The frozen UI-facing set:

```
discovered | probing | extracting | transcribing | diarizing | merging | done | failed
```

- Terminal: `done`, `failed`.
- Everything else is "in flight" → the row shows a live progress bar.
- `failed` carries `error` (a typed-error slug, see phase 07 taxonomy) and offers Retry.

## Types

TS source of truth is `src/ipc/types.ts`; this table is the human summary. Field names are
snake_case on the wire (serde default) — the frontend keeps them snake_case rather than
remapping, so a payload logs identically on both sides.

| Type | Fields |
|---|---|
| `Word` | `text: string`, `start_ms: number`, `end_ms: number`, `p: number` |
| `Segment` | `id`, `chunk_idx`, `start_ms`, `end_ms`, `text`, `words: Word[]`, `speaker_id: number \| null`, `split_of: number \| null` |
| `Speaker` | `id`, `recording_id`, `label` (`"Speaker 1"`), `display_name: string \| null`. **No embedding** — never crosses IPC. |
| `RecordingSummary` | `id`, `path`, `filename`, `recorded_at: number \| null`, `duration_ms: number \| null`, `status`, `stage_detail: string \| null`, `error: string \| null`, `speaker_count`, `available: boolean`, `has_video: boolean` |
| `Recording` | `RecordingSummary` + `container: string \| null` |
| `RecordingDetail` | `{ recording: Recording, segments: Segment[], speakers: Speaker[] }` |
| `SearchHit` | `recording_id`, `filename`, `segment_id`, `start_ms`, `snippet: string` (FTS `snippet()`, `<b>`-marked) |
| `WatchFolder` | `id`, `path`, `track_rule: "auto" \| string`, `enabled: boolean` |

Notes:
- `words` arrives as a parsed array (the command deserializes `segments.words` JSON), never
  as a raw string. Empty → `[]`.
- `speaker_id: null` renders unattributed, not "unknown speaker" (decision: no guessing).
- `available: false` → text usable, player replaced by an "unavailable" notice.

## Commands (Rust `#[tauri::command]`)

All read-side commands hit the frozen schema and are buildable/testable today against a
seeded db — no pipeline required.

```ts
list_recordings(filter?: RecordingFilter, sort?: RecordingSort): RecordingSummary[]
get_recording(id: number): RecordingDetail
search(query: string, limit: number): SearchHit[]
rename_speaker(speaker_id: number, name: string): void   // '' clears display_name
retry_job(recording_id: number): void                    // no-op stub until phase 04
add_watch_folder(path: string): WatchFolder
remove_watch_folder(id: number): void
list_watch_folders(): WatchFolder[]
start_backfill(folder_id: number): void                  // stub until phase 04
```

```ts
type RecordingFilter = { status?: Status; available?: boolean; query?: string };
type RecordingSort   = { by: "recorded_at" | "duration_ms" | "filename"; dir: "asc" | "desc" };
```

`retry_job` / `start_backfill` exist as stubs now so the UI can wire the buttons; they
become real when the worker lands. A stub returns Ok and logs — it never fakes progress.

## Events (Rust → UI, `emit`)

The only genuinely phase-04-coupled surface. UI consumes mocked emissions until the worker
exists; payload shapes are frozen here.

```ts
"job_progress"          { recording_id: number, stage: Status, pct: number }  // pct 0..1
"job_done"              { recording_id: number }
"job_failed"            { recording_id: number, error: string }               // typed slug
"recording_discovered"  { recording_id: number }
```

`pct` is 0..1 (not 0..100). `stage` is the same enum as `status`.

## What is safe to build now vs waits on phase 04

| Build now (no blocker) | Waits on phase 04 |
|---|---|
| All three screens, layout, virtualized lists | Live status chips updating from a real job |
| Video via `convertFileSrc` + dynamic asset scope | `retry_job` actually re-running a job |
| Read commands over seeded db | `start_backfill` actually scanning |
| FTS search UI + `search` command | real `job_progress` emissions |
| `rename_speaker` (real, write-side, testable now) | |

## Fixtures

- `docs/fixtures/seed.sql` — apply on top of a migrated db to exercise the real read
  commands: `sqlite3 "$UNOTTR_DATA_DIR/unottr.db" < docs/fixtures/seed.sql`.
- `src/ipc/mock.ts` — typed mock data + a mock `invoke`/event shim so the React app renders
  with zero Rust. Swap for `@tauri-apps/api` once the commands land.

## Phase 06 additions (settings & shell)

### Types

| Type | Fields |
|---|---|
| `Device` | `"auto" \| "gpu" \| "cpu"` |
| `Resolved` | `"gpu" \| "cpu"` — what `device: "auto"` actually resolves to on this machine |
| `Settings` | `model_tier: string`, `language: string \| null`, `device: Device`, `diarize_threshold: number \| null`, `ffmpeg_path: string \| null`, `ffprobe_path: string \| null`, `cache_dir: string \| null`, `autostart: boolean`, `close_to_tray: boolean`, `tray_available: boolean`, `first_run_complete: boolean` |
| `ModelInfo` | `tier: "turbo" \| "medium" \| "small"`, `name: string`, `size: number`, `downloaded: boolean` |
| `DiskUsage` | `models_bytes: number`, `cache_bytes: number` |
| `BackfillEstimate` | `folder: string`, `count: number`, `total_duration_ms: number`, `estimated_processing_ms: number` |

`tray_available` is a runtime fact (whether this session could build a tray icon at all),
not a persisted setting — always read it fresh from `get_settings`, never cache it.

`first_run_complete` is UI-only bookkeeping (gates the first-run wizard) — core's
`Settings` struct has no field for it; it rides the same free-form settings kv table via
`set_setting("first_run_complete", "1")`, which works for any key since `set_raw` isn't
restricted to core's known fields.

### Commands

```ts
set_watch_folder_enabled(id: number, enabled: boolean): void
set_watch_folder_track_rule(id: number, track_rule: string): void
backfill_estimate(folder_id: number): BackfillEstimate       // read-only; call before start_backfill
get_settings(): Settings
set_setting(key: string, value: string): Settings            // one key/value pair per call
list_models(): ModelInfo[]                                   // turbo/medium/small only
detected_device(): Resolved                                    // what device:"auto" resolves to, probed fresh
disk_usage(): DiskUsage
download_model(tier: string): void                           // progress via model_download_progress
cancel_model_download(tier: string): void
clear_cache(): void                                           // wipes the pcm cache dir
get_log_dir(): string                                          // for revealItemInDir
export_transcript(recording_id: number, format: string, dest_path: string): void
  // format: "txt" | "json" | "srt" | "vtt"; dest_path comes from a native save dialog
```

`set_setting`'s `value` is the same raw string encoding `db::settings::keys` already uses on
disk (`"auto"`/`"gpu"`/`"cpu"` for device, `"1"`/`"0"` for booleans) — the ipc layer validates
against that encoding and rejects anything else as an `Err`.

**Restart semantics.** `model_tier`/`language`/`device`/`diarize_threshold` are re-read from
the settings table by the worker before every job (`settings_aware=true` in
`IngestService::start`), so they take effect on the *next* job with no restart. `ffmpeg_path`,
`ffprobe_path`, and `cache_dir` are only read once at app startup (building `FfmpegCli`/
`Paths` happens in `src-tauri/src/lib.rs::run`'s `setup`), so changing those needs an app
restart to take effect — flagged in MANUAL-CHECKS.md rather than silently hot-reloaded.

### Events

```ts
"model_download_progress"  { model: string, pct: number }   // pct 0..1, model = tier name
```

No separate done/error event — the frontend treats `pct === 1` as done and falls back to
re-calling `list_models`/`disk_usage` to notice a failed or cancelled download.

**Real-time factor.** The plan calls for showing a measured real-time factor next to the
compute override. Core doesn't persist per-job processing-time-vs-media-duration anywhere
(only start/done timestamps on the recording, not wall-clock compute time), so there's no
data source for this yet — deferred, not wired to a fake number. `detected_device` covers
the rest of the Compute group (what auto resolves to) honestly.

### Tray status line

Not an IPC surface (native menu text, not emitted to the webview) — `"Idle"` when nothing is
in flight, else `"Transcribing {active} of {total}"`. Formatting lives in
`src-tauri/src/tray.rs::status_line`, unit tested there.
