# unottr

A desktop app that watches folders for meeting recordings and turns them into a
searchable, speaker-labelled transcript with the video playable beside it. Point it at a
folder, walk away, come back to a transcript. No cloud and no accounts; the one optional
cloud feature is an AI overview you trigger yourself, with your own API key.

## What it does

- Watches folders you pick; any new recording is transcribed and diarized automatically.
- Local speech-to-text (whisper.cpp) with automatic speaker separation (sherpa-onnx).
  Name a speaker once and later recordings recognise them by voice.
- Full-text search across every transcript, click a search hit to jump to that moment in
  the video.
- Optional AI overview per recording: summary, decisions and action items, every bullet
  linked to the moment it came from. Off until you paste your own Mistral key, and it only
  ever runs when you press the button.
- Export to `.txt` / `.json` / `.srt` / `.vtt`.
- Runs quietly in the background (tray icon), picks up where it left off after a crash or
  restart.

## Privacy

There is no network call in the transcription/diarization path. Recordings are watched,
transcribed, diarized, searched and exported entirely on this machine; the only things the
app fetches on its own are the model weights on first use (once, then cached) and its own
update/packaging tooling at build time.

The AI overview is the single exception, and it is opt-in twice over: nothing happens
until you add an API key, and then nothing happens until you press *Generate* on a
recording. Before the first call it shows you the exact text it is about to send. What
goes out is transcript text and speaker names — never audio, never video, never frames.
A pseudonymize toggle replaces names with "Speaker 1" before sending. The key is stored
via the OS keyring (`safeStorage`); if the platform has none, the app says so and asks
before falling back to plaintext.

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
- A Mistral API key, only if you want AI overviews. Without one the rest of the app is
  unaffected.

## Developing

```sh
pnpm install
pnpm dev                      # electron-vite: main, preload and renderer, all hot-reloaded
pnpm typecheck                # two projects: node (main/preload/worker/test) and web
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
