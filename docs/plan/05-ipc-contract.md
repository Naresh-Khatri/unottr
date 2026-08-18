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
