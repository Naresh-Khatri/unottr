# unottr — build plan

Eight phases. Each is a separate file and is meant to be completed and verified before
the next one starts. Phases 01–03 are deliverable and testable **without any UI** — they
are driven by the `unottr` CLI built in phase 00, against the real recordings already on
this machine.

| Phase | File | Outcome |
|---|---|---|
| 00 | [00-foundations.md](00-foundations.md) | Workspace, DB + migrations, config, logging, CLI harness |
| 01 | [01-media-pipeline.md](01-media-pipeline.md) | Probe any file, pick audio track, extract 16k mono PCM |
| 02 | [02-transcription.md](02-transcription.md) | whisper.cpp + Vulkan, chunked with checkpoints, model manager |
| 03 | [03-diarization.md](03-diarization.md) | sherpa-onnx speakers, merged onto the transcript |
| 04 | [04-ingest.md](04-ingest.md) | Watcher, job queue, crash recovery, backfill, file identity |
| 05 | [05-ui.md](05-ui.md) | Recordings list, transcript view, video player, search |
| 06 | [06-settings-and-shell.md](06-settings-and-shell.md) | Settings, tray, autostart, first-run, export |
| 07 | [07-hardening-and-packaging.md](07-hardening-and-packaging.md) | Failure handling, perf pass, AppImage |

## Working agreements

- **Verification is non-build**: `cargo check`, `cargo clippy`, `cargo test`, `tsc --noEmit`,
  lint. Nobody runs `cargo build --release` or `pnpm build` to "check" something.
- **Dev runs are yours.** No agent starts `pnpm tauri dev` or any dev server.
- **The corpus is real.** ~10 OBS recordings in `/home/naresh` (0.6–1.8 GB, single AAC
  stereo track, 48 kHz). Every phase from 01 on is validated against these, not synthetic
  fixtures alone.
- **Never modify a user's recording.** The pipeline is strictly read-only on source files.

## Definition of done for v1

Point the app at a folder, walk away, and come back to a searchable, speaker-labelled
transcript with the video playable beside it.
