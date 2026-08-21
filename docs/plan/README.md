# unottr — build plan

**Current plan: [09-ai-overview.md](09-ai-overview.md)**, with phase 08's packaging boxes
still open behind it. The Rust is gone as of 08.7 step 4; the last commit that contains it
is tagged `rust-final`. Everything before 08 is superseded history — phases 00–07 describe
a Rust/Tauri app that no longer exists. They are kept because they are where each behaviour
the TypeScript app must reproduce was decided and measured, and because the fixtures they
produced are still what the port is checked against.

| Phase | File | Outcome | State |
|---|---|---|---|
| 00 | [00-foundations.md](00-foundations.md) | Workspace, DB + migrations, config, logging, CLI harness | superseded |
| 01 | [01-media-pipeline.md](01-media-pipeline.md) | Probe any file, pick audio track, extract 16k mono PCM | superseded |
| 02 | [02-transcription.md](02-transcription.md) | whisper.cpp + Vulkan, chunked with checkpoints, model manager | superseded |
| 03 | [03-diarization.md](03-diarization.md) | sherpa-onnx speakers, merged onto the transcript | superseded |
| 04 | [04-ingest.md](04-ingest.md) | Watcher, job queue, crash recovery, backfill, file identity | superseded |
| 05 | [05-ui.md](05-ui.md) | Recordings list, transcript view, video player, search | superseded |
| 06 | [06-settings-and-shell.md](06-settings-and-shell.md) | Settings, tray, autostart, first-run, export | superseded |
| 07 | [07-hardening-and-packaging.md](07-hardening-and-packaging.md) | Failure handling, perf pass, AppImage | superseded |
| 08 | [08-typescript-migration.md](08-typescript-migration.md) | Tauri/Rust -> Electron/TypeScript, `crates/` deleted | done bar packaging |
| 09 | [09-ai-overview.md](09-ai-overview.md) | Mistral summary, decisions, role-aware tasks, cited frames | **current** |

The decisions in 00–07 still hold; only their implementation moved. Where a superseded
phase and phase 08 disagree about *how* something is done, phase 08 wins — where they
disagree about *what* the app does, that is a porting bug.

## Working agreements

- **Verification is non-build**: `pnpm typecheck`, `pnpm test`. Nobody runs `pnpm build` or
  `pnpm dist` to "check" something.
- **Dev runs are yours.** No agent starts `pnpm dev` or any dev server.
- **The corpus is real.** ~10 OBS recordings in `/home/naresh` (0.6–1.8 GB, single AAC
  stereo track, 48 kHz). Every phase from 01 on is validated against these, not synthetic
  fixtures alone.
- **Never modify a user's recording.** The pipeline is strictly read-only on source files.

## Definition of done for v1

Point the app at a folder, walk away, and come back to a searchable, speaker-labelled
transcript with the video playable beside it.
