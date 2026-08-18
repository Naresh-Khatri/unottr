# unottr

A desktop app that watches folders for meeting recordings and turns them into a
searchable, speaker-labelled transcript with the video playable beside it. Point it at a
folder, walk away, come back to a transcript. No cloud, no accounts, no LLM.

## What it does

- Watches folders you pick; any new recording is transcribed and diarized automatically.
- Local speech-to-text (whisper.cpp) with automatic speaker separation (sherpa-onnx) —
  anonymous speaker labels, renameable per recording.
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
- **ffmpeg / ffprobe** — bundled in the AppImage (LGPL build, see below); the tarball/AUR
  build expects them on `PATH`.
- A GPU with a Vulkan driver is used automatically if present (whisper.cpp's Vulkan
  backend); otherwise it falls back to CPU — see DESIGN.md's *Vulkan packaging* and
  *Measured performance* sections for what that costs in practice (CPU is viable, just
  slower than realtime for the larger model tiers).
- First run downloads a whisper model (~150 MB–575 MB depending on tier) and two small
  diarization models (~35 MB total); everything after that is offline.

## Building / packaging

```sh
pnpm install
pnpm tauri build              # AppImage, system ffmpeg only

scripts/fetch-ffmpeg.sh       # fetch the LGPL ffmpeg/ffprobe used by packaging (not
                               # checked into git — ~220 MB, see THIRD-PARTY.md)
pnpm tauri build              # AppImage with ffmpeg bundled inside
```

In some sandboxed build environments, `pnpm tauri build`'s own final AppImage step fails
with an opaque `failed to run linuxdeploy` even though the AppDir was assembled correctly
(cargo build, resource copy, and linuxdeploy's own library deployment all succeed) and the
exact same cached `linuxdeploy-plugin-appimage` tool runs fine invoked directly. If that
happens, `scripts/build-appimage.sh` retries `pnpm tauri build` and, on that specific
failure, packages the already-assembled AppDir by hand with the same cached tool — no code
changes needed, just a different final step.

If AppImage tooling (`linuxdeploy` et al., fetched by the Tauri bundler on first build)
can't be downloaded at all, `cargo build --release` still produces a working binary; pair
it with `scripts/package-tarball.sh` for a plain tarball you can run without the AppImage.

See `THIRD-PARTY.md` for what's bundled and its licensing, `DESIGN.md` for the
architecture and measured performance, and `MANUAL-CHECKS.md` for the checks that need a
live app rather than a test suite.
