# Phase 06 — Settings and shell

**Goal:** turn the window into an application — one that runs in the background, starts
with the session, and can be configured without editing a database.

**Depends on:** phase 05.

---

## Deliverables

- Settings screen.
- Tray icon with graceful degradation.
- Close-to-tray, opt-in autostart.
- First-run flow.
- Transcript export.

## Tasks

### 1. Settings screen

| Group | Controls |
|---|---|
| Watch folders | add / remove / enable, per-folder track rule (decision #14), backfill trigger |
| Model | tier picker (turbo / medium / small), download state, disk usage |
| Compute | detected device, GPU/CPU/auto override, current real-time factor |
| Transcription | language auto-detect or forced |
| Diarization | similarity threshold — the one knob that fixes bad output in the field |
| Advanced | ffmpeg path, cache location, "clear cache", open log folder |

Every setting is persisted in the `settings` table and read by the core, not held only in
frontend state.

### 2. Model download UX

`ModelMissing` from phase 02 surfaces here as a first-class action: size, progress,
cancel, resume. A blocked first run must be obvious and self-explanatory — this is the
first thing a new user hits after picking a folder.

### 3. Tray and window lifecycle (decision #20)

- Tray menu: Show, status line (`Idle` / `Transcribing 2 of 5`), Quit.
- Closing the window **keeps the watcher running**. A folder watcher that only watches
  while you stare at it has no reason to exist.
- **Degrade gracefully**: Tauri's tray needs `libayatana-appindicator`, and GNOME shows no
  tray icons at all without a user-installed extension. Detect tray availability at
  startup; if unavailable, close **must** quit, with a one-time explanation. Never leave a
  user with a running process they cannot see or stop.
- First close shows a one-time "still running in the tray" hint.

### 4. Autostart

`tauri-plugin-autostart`, **off by default**, one checkbox. Writes a `.desktop` entry to
`~/.config/autostart`. Verify it is removed cleanly when unchecked.

### 5. First run

1. Welcome + what the app does.
2. Pick a watch folder.
3. Download the model (progress, blocking, explained).
4. Offer backfill of existing files with a count and time estimate — **confirm required**
   (decision #10).
5. Note that MKV is recommended over MP4, with the honest reason: a crashed OBS leaves an
   `.mp4` unrecoverable, while an `.mkv` survives. A hint, never a requirement — decision #7
   is that the app adapts to the user's setup, not the reverse.

### 6. Export (decision #17)

SQLite is the source of truth, so export is the escape hatch: `.txt`, `.json`, `.srt`,
`.vtt` for a single recording, via a native save dialog. No automatic sidecar files — a
background app that silently writes into a user's folders is intrusive.

## Acceptance criteria

- [ ] Every setting persists across a restart and is honoured by the core.
- [ ] Changing the model tier downloads it and the next job uses it.
- [ ] Forcing CPU actually runs on CPU (confirm in logs).
- [ ] Close hides to tray when a tray exists; **quits** when it does not.
- [ ] Quit from the tray stops the worker cleanly at a chunk boundary.
- [ ] Autostart on then off leaves no `.desktop` file behind.
- [ ] First run works from a genuinely empty data dir (`UNOTTR_DATA_DIR=$(mktemp -d)`).
- [ ] All four export formats produce valid output; SRT/VTT verified in a real player.
- [ ] `tsc --noEmit` and lint clean.

## Out of scope

Packaging and the failure-handling polish pass — phase 07.
