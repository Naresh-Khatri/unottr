# unottr

A desktop app that watches folders for meeting recordings and turns them into a
searchable, speaker-labelled transcript with the video playable beside it. Point it at a
folder, walk away, come back to a transcript. No cloud, no accounts, no LLM.

## What it does

- Watches folders you pick; any new recording is transcribed and diarized automatically.
- Local speech-to-text (whisper.cpp) with automatic speaker separation (sherpa-onnx).
  Name a speaker once and later recordings recognise them by voice.
- Full-text search across every transcript, click a search hit to jump to that moment in
  the video.
- Export to `.txt` / `.json` / `.srt` / `.vtt`.
- Runs quietly in the background (tray icon), picks up where it left off after a crash or
  restart.

## Privacy

Nothing leaves the machine. There is no network call in the transcription/diarization
path — the only things this app fetches over the network, ever, are the model weights on
first use (once, then cached) and its own update/packaging tooling at build time. Audio,
video, and transcripts never go anywhere but the local SQLite database and local disk
cache.

## What it needs

- **Linux** (v1 target; the stack is written to keep macOS/Windows open later, see
  DESIGN.md).
- **ffmpeg / ffprobe** — bundled in the AppImage (LGPL build, see below); a dev run picks
  them up from `resources/bin/` or `PATH`.
- A GPU with a Vulkan driver is used automatically if present (whisper.cpp's Vulkan
  backend); otherwise it falls back to CPU — see DESIGN.md's *Vulkan packaging* and
  *Measured performance* sections for what that costs in practice (CPU is viable, just
  slower than realtime for the larger model tiers).
- First run downloads a whisper model (~150 MB–575 MB depending on tier) and two small
  diarization models (~35 MB total); everything after that is offline.

## Developing

```sh
pnpm install
pnpm dev                      # electron-vite: main, preload and renderer, all hot-reloaded
pnpm typecheck                # five tsconfig projects
pnpm test                     # vitest; the *.integration.test.ts files need real models
```

Native code is all prebuilt npm packages (whisper, sherpa-onnx, better-sqlite3), so there
is no compiler step and no rebuild-for-electron — every one of them is N-API.

## Packaging

```sh
scripts/fetch-ffmpeg.sh         # LGPL ffmpeg/ffprobe -> resources/bin (~220 MB, not in git)
scripts/fetch-vulkan-loader.sh  # libvulkan.so.1 -> resources/lib (the loader only, never an ICD)
pnpm dist                       # electron-vite build + electron-builder -> release/*.AppImage
```

Both fetch scripts are required: without ffmpeg every job parks on a typed error, and
without the Vulkan loader the whisper addon will not load at all on a machine that has no
driver installed (it does not degrade to CPU on its own — see DESIGN.md's *Vulkan
packaging*).

See `THIRD-PARTY.md` for what's bundled and its licensing, `DESIGN.md` for the
architecture and measured performance, and `MANUAL-CHECKS.md` for the checks that need a
live app rather than a test suite.
