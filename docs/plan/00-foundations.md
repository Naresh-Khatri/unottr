# Phase 00 — Foundations

**Goal:** an empty but correct skeleton — workspace, database, config, logging, and a CLI
that later phases hang their work on. No pipeline logic yet.

**Depends on:** nothing.

---

## Deliverables

- Cargo workspace with `unottr-core` (lib), `unottr-cli` (bin), `src-tauri` (Tauri shell).
- SQLite schema + forward-only migrations.
- XDG-correct paths for db, cache, models, logs.
- Structured logging to file and stderr.
- Typed error enum used across the crate.
- Tauri v2 + React + Vite + Tailwind shell that opens a window and nothing more.

## Tasks

### 1. Workspace layout

```
unottr/
  Cargo.toml            # workspace
  crates/
    unottr-core/        # all logic, no tauri dep
    unottr-cli/         # headless driver for phases 01-03
  src-tauri/            # thin shell
  src/                  # react + vite
  docs/plan/
```

`unottr-core` must not depend on `tauri`. This is what makes phases 01–03 testable without
a UI and keeps the door open on the non-Linux targets from decision #1.

### 2. Paths (`directories` crate)

| What | Path |
|---|---|
| DB | `~/.local/share/unottr/unottr.db` |
| Models | `~/.local/share/unottr/models/` |
| PCM cache | `~/.cache/unottr/pcm/` |
| Logs | `~/.local/state/unottr/logs/` |

Every path is overridable by env var (`UNOTTR_DATA_DIR` etc.) so tests never touch the
real database.

### 3. Schema + migrations

Hand-rolled versioned migrations keyed on `PRAGMA user_version` — no migration framework
for a schema this size. Each migration is a `&str` in an ordered array; the runner applies
everything above the current version inside one transaction.

```sql
-- v1
CREATE TABLE recordings (
  id            INTEGER PRIMARY KEY,
  path          TEXT NOT NULL UNIQUE,
  fp_size       INTEGER NOT NULL,
  fp_head       BLOB NOT NULL,      -- blake3 of first 1 MiB
  fp_tail       BLOB NOT NULL,      -- blake3 of last 1 MiB
  container     TEXT,
  duration_ms   INTEGER,
  recorded_at   INTEGER,            -- from mtime, or parsed filename
  status        TEXT NOT NULL,      -- see phase 04 state machine
  stage_detail  TEXT,               -- free-form progress note
  error         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_chunk_idx INTEGER,           -- transcription checkpoint
  available     INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE speakers (
  id            INTEGER PRIMARY KEY,
  recording_id  INTEGER NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,      -- "Speaker 1"
  display_name  TEXT,               -- user rename, decision #4
  embedding     BLOB,               -- decision #17: stored from day one
  UNIQUE(recording_id, label)
);

CREATE TABLE segments (
  id            INTEGER PRIMARY KEY,
  recording_id  INTEGER NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  chunk_idx     INTEGER NOT NULL,   -- which checkpoint produced this
  start_ms      INTEGER NOT NULL,
  end_ms        INTEGER NOT NULL,
  text          TEXT NOT NULL,
  words         TEXT,               -- json word timestamps, needed by phase 03
  speaker_id    INTEGER REFERENCES speakers(id) ON DELETE SET NULL
);
CREATE INDEX idx_segments_recording ON segments(recording_id, start_ms);

CREATE VIRTUAL TABLE segments_fts USING fts5(
  text, content='segments', content_rowid='id', tokenize='unicode61'
);
-- + triggers to keep fts in sync on insert/update/delete

CREATE TABLE watch_folders (
  id         INTEGER PRIMARY KEY,
  path       TEXT NOT NULL UNIQUE,
  track_rule TEXT NOT NULL DEFAULT 'auto',
  enabled    INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

`PRAGMA journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000` on every connection.

### 4. Errors and logging

- `thiserror` enum: `Io`, `Db`, `Ffmpeg`, `Probe`, `Whisper`, `Diarize`, `ModelMissing`,
  `Cancelled`. Phase 07 maps these to user-facing messages — keep them distinguishable.
- `tracing` + `tracing-subscriber`, rolling file appender, `RUST_LOG` respected.

### 5. CLI harness

`unottr-cli` with stubs that later phases fill in: `probe`, `extract`, `transcribe`,
`diarize`, `run` (full pipeline on one file), `db` (inspect/reset).

This is the single highest-leverage item in phase 00 — it is how phases 01–03 get built
and validated with no UI in existence.

### 6. Tauri shell

`pnpm create tauri-app` (React + TS + Vite), add Tailwind. Window opens, renders a
placeholder, wires `unottr-core` as a dependency. No commands yet.

## Acceptance criteria

- [x] `cargo check --workspace` and `cargo clippy --workspace -- -D warnings` clean.
- [x] `cargo test -p unottr-core` passes, including a migration test that opens a temp DB,
      migrates from scratch, and asserts `user_version`.
- [x] Migrations are idempotent — running twice is a no-op.
- [x] `unottr db path` prints the XDG paths; `UNOTTR_DATA_DIR=/tmp/x unottr db path` honours the override.
- [x] `tsc --noEmit` and lint clean on the frontend.
- [ ] You can launch the Tauri window and see the placeholder (your run, not an agent's).

## Out of scope

Any pipeline logic, IPC commands, UI beyond a placeholder.

---

## Outcome

Completed. Verified with `cargo check --workspace --all-targets`, `cargo clippy --workspace
--all-targets -- -D warnings`, `cargo fmt --check`, `cargo test --workspace` (6 passing),
and `tsc --noEmit` — all clean.

**Resolved versions:** tauri 2.11.5 / tauri-build 2.6.3, rusqlite 0.40.2 (bundled),
directories 6.0, clap 4.6, tracing-subscriber 0.3.23, React 19.2, Vite 8.2, Tailwind 4.3,
TypeScript 7.0. Edition 2024, MSRV 1.88.

**Findings that affect later phases:**

- **FTS5 is available in rusqlite's bundled SQLite** with no extra feature flag — the one
  schema risk in this phase. Verified by a test that inserts a segment, matches it through
  `segments_fts`, deletes it, and confirms the index follows. Phase 05's search is unblocked.
- **`UNOTTR_DATA_DIR` relocates cache and state as well**, so a single env var fully
  isolates a test run. Confirmed the real `~/.local/share/unottr` is never created.
- **Tauri requires RGBA icons** — an RGB PNG fails at `generate_context!` with a proc-macro
  panic, not a helpful error. Icons are flat-colour placeholders; phase 07 replaces them.
- **TypeScript 7 rejects `noEmit` in a composite referenced project**, so the usual
  `tsconfig.node.json` reference was dropped in favour of a single tsconfig including
  `vite.config.ts`.

**Deliberately not built** (belongs to later phases): `Error::is_terminal` and the retry
policy (phase 07), the `RecordingStatus` enum (phase 04), any IPC command (phase 05).
