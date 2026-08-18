# Phase 04 — Ingest

**Goal:** the part that makes it an app instead of a script. Watch folders, queue work,
survive crashes, and never mistake a half-written recording for a finished one.

**Depends on:** phases 01–03 (a working pipeline to schedule).

---

## Deliverables

- File watcher with three-stage completion detection (decision #10).
- Persisted job queue and state machine, serial worker (decision #18).
- Startup reconciliation and resume.
- File identity: fingerprints, move/rename re-linking, missing-file handling (decision #22).
- Backfill with explicit confirmation.

## Tasks

### 1. Completion detection

A file is only queued after **all three** pass:

1. `notify` (inotify) reports `CLOSE_WRITE` — or the file was found by a startup scan.
2. **Size stable**: poll every 2 s, require 5 consecutive identical sizes (~10 s).
3. `ffprobe` parses it and reports a duration.

Any one alone is insufficient. OBS holds the file open across the whole meeting, and an
in-progress MP4 has no readable duration. Getting this wrong means transcribing half a
meeting and calling it done — the most damaging bug this app can have.

Extension allowlist, configurable, broad by default:
`mkv mp4 mov webm m4a mp3 wav flac ogg opus avi ts flv`.

### 2. Identity (decision #22)

Fingerprint = `(size, blake3(first 1 MiB), blake3(last 1 MiB))`. Cheap and constant-time
regardless of the 1.8 GB files in the corpus.

- **New file**: fingerprint matches an existing row -> the file was moved or renamed.
  Update `path`, set `available = 1`, **do not reprocess**.
- **Missing file** at startup scan: before marking `available = 0`, search the watch
  folders for a fingerprint match.
- **Never delete a transcript** because the video vanished. `available = 0` keeps the text
  searchable with the player disabled. Users delete 1.8 GB videos; the transcript is the
  small valuable artifact and it outlives the source.

### 3. State machine

```
Discovered -> Probing -> Extracting -> Transcribing -> Diarizing -> Merging -> Done
                  \___________ any stage ___________/ -> Failed
```

`recordings.status` holds the state; `attempts` and `error` travel with it.

- **Serial worker**, concurrency 1. Whisper on the GPU saturates the device; two jobs just
  thrash VRAM and both finish later.
- Retry twice on failure, then park in `Failed` with the error preserved for the UI's
  manual retry (phase 05).
- Graceful shutdown: finish the current chunk, checkpoint, exit. Never abandon a job
  mid-chunk when a clean boundary is 30 seconds away.

### 4. Startup reconciliation

Any row in a non-terminal state means the app died mid-job:

- `Transcribing` -> resume from `last_chunk_idx` (phase 02 owns the correctness here).
- Any other stage -> restart that stage from the beginning. They are all short and
  idempotent; only transcription is long enough to be worth checkpointing.
- Clear stale PCM from the cache dir for jobs that are no longer active.

### 5. Backfill

Adding a watch folder scans it and finds unprocessed files. Show the count and a duration
estimate (using the phase 02 real-time factor), then **require an explicit confirmation**.

Ten recordings at ~35 minutes each is a multi-hour first run. That must be a deliberate
click, never a surprise that starts pinning the GPU because someone added a folder.

## Acceptance criteria

- [ ] Drop a finished file into a watched folder -> it processes to `Done`.
- [ ] **Growing-file test**: `dd` a file into the folder in slow increments; it is not
      queued until writes stop and the size is stable. This is the phase's core test.
- [ ] A truncated MP4 fails at `Probing` with a clear error and does not retry forever.
- [ ] Rename a processed file -> re-linked, not reprocessed. Assert the segment count is
      unchanged and no job ran.
- [ ] Delete a processed file -> `available = 0`, transcript still searchable.
- [ ] Move it back -> `available = 1` again.
- [ ] `kill -9` mid-transcription -> restart resumes at the checkpoint.
- [ ] Backfill does nothing at all until confirmed.
- [ ] Watcher survives a folder being deleted and recreated.

## Risks

- inotify watches are a limited kernel resource; recursive watches on a huge tree can
  exhaust them. Watch folders non-recursively by default.
- Network mounts and some FUSE filesystems do not deliver inotify events. The size-stable
  poll is the safety net — keep a periodic rescan so nothing is lost forever.

## Out of scope

Any UI. This phase is verified through the CLI and the database.
