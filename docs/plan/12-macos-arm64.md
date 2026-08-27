# Phase 12: Apple Silicon tester build

**Goal:** produce an arm64 macOS app that transcribes with Whisper Large V3 Turbo over
Metal and diarizes locally with sherpa-onnx on the CPU.

**Target:** M1 or newer, including an M1 with 8 GB unified memory, on macOS 13 or newer.

**Distribution:** internal testing only. The first artifact is an ad-hoc-signed `.app`
created on a Mac and copied as a zip. DMG packaging, Developer ID signing, notarization,
updates, and the Mac App Store are not part of this phase.

## Decisions

- Build arm64 only. Do not ship Intel or Universal binaries.
- Select Whisper's Darwin arm64 package explicitly. Its default variant uses Metal.
- Download Large V3 Turbo during first-run and select it by default.
- Keep Small installed as the offline recovery model. Retry it on Metal memory exhaustion.
- Use the existing sherpa-onnx CPU diarizer on macOS. Do not port the Vulkan Sortformer
  runtime in this phase.
- Bundle pinned arm64 FFmpeg and FFprobe binaries built with LGPL-only options.
- Use macOS application-data, cache, and log directories. Keep Linux XDG paths unchanged.
- Preserve the Linux AppImage, Vulkan Whisper, and Vulkan Sortformer paths.
- Build and test native artifacts on macOS from a fresh dependency install. Never copy
  Linux `node_modules` or `resources/bin` into the Mac checkout.

## What blocks macOS today

The Electron and React layers are portable, but the native path is Linux-specific:

- `src/worker/whisper.ts` and `src/worker/vad.ts` always request the `vulkan` package.
- `src/main/models/device.ts` only discovers Vulkan devices, so `auto` resolves to CPU on
  Apple Silicon.
- `electron-builder.yml` only emits an AppImage. It excludes Darwin SQLite binaries,
  unpacks the Linux sherpa package, and copies ELF FFmpeg, Sortformer, and Vulkan files.
- The FFmpeg and Sortformer staging scripts produce Linux x64 files.
- `src/main/paths.ts` uses XDG paths on every platform.
- `src/main/autostart.ts` writes a Freedesktop desktop file on every platform.
- No packaged test proves that the utility process can load all three Darwin arm64 native
  dependencies: Whisper, sherpa-onnx, and better-sqlite3.

Sortformer is deliberately excluded. Its current runtime is a Linux CLI with shared ELF
libraries and a hard requirement that stderr prove Vulkan use. A Metal port needs its own
upstream investigation, Mach-O runtime build, dylib path handling, and signing work.

## Platform shape

Keep platform choices at the edges instead of scattering `process.platform` checks through
the pipeline.

1. A Whisper backend helper selects `default` on Darwin and `vulkan` elsewhere.
2. Device resolution treats Darwin arm64 as GPU-capable for Whisper. The existing Vulkan
   probe continues to decide Linux GPU availability and Sortformer availability.
3. Resource lookup selects a platform-and-architecture directory. Mac packages never see
   Linux binaries, and Linux packages never see Mach-O files.
4. Path lookup selects native macOS locations while retaining the existing environment
   overrides used by tests.
5. Packaging has separate Linux and macOS resource rules. Shared application files stay in
   the common allowlist.

Do not report an Apple GPU through the existing `gpus()` Vulkan function. Sortformer and
Linux resource meters use that function as proof of Vulkan availability. Whisper's Metal
capability needs a separate decision.

## Implementation order

Current implementation status as of 2026-08-27:

| Phase | Repository work | Still needs the M1 host |
|---|---|---|
| 12.1 | Backend selection, Apple GPU planning, and native smoke command are in place | Fresh arm64 install and smoke run |
| 12.2 | Turbo default, Small recovery download, and combined setup size are in place | Clean offline setup run |
| 12.3 | Migration, Metal OOM classification, sticky Small retry, and checkpoint reset are tested | Forced OOM with the real Metal addon |
| 12.4 | Pinned source staging script and platform-qualified lookup are in place | Compile and inspect both Mach-O binaries |
| 12.5 | arm64 dir/zip target, native dependency filters, ICNS staging, and ad-hoc signing are configured | Package, inspect, sign, unzip, and open |
| 12.6 | Native Library paths and the macOS autostart guard are tested | Tray and window lifecycle checks |
| 12.7 | Linux unit, native, FFmpeg, and private-corpus runs pass | The packaged clean-room checklist |

### 12.1 Select the native Whisper backend

- Add a small, testable helper for the `@fugood/whisper.node` package variant.
- Request `default` on Darwin and `vulkan` on Linux.
- Use the same variant for Whisper and Silero VAD. VAD still sets `useGpu: false`.
- Resolve `device: auto` to GPU on Darwin arm64 so first-run and job planning choose the
  Metal path and the Turbo model.
- Keep explicit CPU and GPU settings unchanged.
- Add an opt-in native-addon smoke command. It must dlopen the Whisper package selected for
  the host, load sherpa-onnx, and open an in-memory better-sqlite3 database.

Acceptance:

- Unit tests prove Darwin arm64 selects `default` plus GPU, while Linux keeps Vulkan probing.
- `pnpm smoke:native` passes after a fresh `pnpm install` on the M1 test Mac.
- The smoke output identifies the platform, architecture, and Whisper variant.

### 12.2 Make model onboarding Mac-aware

- Preselect Turbo on Apple Silicon. Keep the tier selector available to testers.
- Download and verify Turbo, Small, VAD, pyannote segmentation, and CAM++ embedding models.
- Show the combined first-run download size before starting.
- Treat the Small model as required support data on Mac, not as an optional later download.
- Keep every model version, byte size, and SHA-256 value in the catalog.

Acceptance:

- A fresh Mac can finish setup, disconnect from the network, and process a recording.
- Setup cannot finish with Turbo present but the offline recovery model absent.
- Linux onboarding behavior changes only where shared UI tests require it.

### 12.3 Add the Metal memory fallback

The current queue retries a GPU out-of-memory failure on the CPU with the same model. That
is the wrong recovery for Turbo on an 8 GB Mac.

- Classify known Metal allocation failures as `gpu_oom` without treating every worker crash
  as an out-of-memory event.
- On Darwin, retry the recording with Small on Metal once.
- Persist the per-recording fallback choice so an app restart does not retry Turbo forever.
- Keep the current Linux GPU-to-CPU fallback.
- Record requested model, actual model, backend, and fallback reason in logs and diagnostics.

Acceptance:

- A forced Metal OOM produces one transparent Small/Metal retry.
- Cancellation never triggers fallback.
- A generic native crash remains a visible failure.
- Retrying or restarting the app does not create an infinite Turbo failure loop.

### 12.4 Stage arm64 FFmpeg

- Add a macOS arm64 staging script with pinned FFmpeg source and dependency revisions.
- Configure an LGPL-only build. Reject `--enable-gpl` and `--enable-nonfree` in the staged
  binary's reported configuration.
- Stage `ffmpeg`, `ffprobe`, the source revision, configure flags, SHA-256 hashes, and license.
- Make resource lookup use binaries without file extensions on both supported platforms.

Acceptance:

- `file` reports arm64 Mach-O for both binaries.
- `ffmpeg -version` reports the pinned revision and contains neither forbidden flag.
- Probe, PCM extraction, thumbnails, cancellation, and paths containing spaces pass on Mac.

### 12.5 Package native dependencies

- Add an arm64 macOS target that produces an unpacked `.app` and zipped tester artifact.
- Set the deployment target to macOS 13.
- Keep `npmRebuild: false` only after the fresh Mac install proves every Node-API prebuild
  matches Electron.
- Retain `better-sqlite3/prebuilds/darwin-arm64.node` and exclude unrelated architectures.
- Unpack the Darwin Whisper, sherpa-onnx, and better-sqlite3 native files from ASAR.
- Preserve adjacent sherpa dylibs and repair their loader paths if the upstream package needs
  it. Verify with `otool -L` from inside the finished app.
- Exclude Sortformer and all Vulkan resources from the Mac artifact.
- Use an `.icns` application icon and ad-hoc sign the app, including nested native code.

Acceptance:

- Every Mach-O executable and library inside the app reports arm64 only.
- `codesign --verify --deep --strict` passes with the ad-hoc signature.
- The artifact contains no `.so`, Linux FFmpeg, Vulkan loader, or x64 native addon.
- A tester can unzip and open the app using the documented Gatekeeper procedure.

### 12.6 Use native paths and lifecycle behavior

- Store the database and models under `~/Library/Application Support/unottr`.
- Store PCM and thumbnails under `~/Library/Caches/unottr`.
- Store logs under `~/Library/Logs/unottr`.
- Keep `UNOTTR_DATA_DIR`, `UNOTTR_CACHE_DIR`, and `UNOTTR_STATE_DIR` authoritative for
  isolated tests.
- Retain the existing activate and last-window behavior on macOS.
- Make autostart unavailable on Mac for this phase instead of writing a `.desktop` file.
- Check the tray icon in template-image mode. A missing tray must still degrade to normal
  window-close behavior.

### 12.7 Prove the packaged pipeline

Run this on the M1 with 8 GB RAM from a clean checkout and a fresh package install:

1. Remove only the dedicated test data directory.
2. Install dependencies on the Mac.
3. Run typechecks, unit tests, and `pnpm smoke:native`.
4. Create the arm64 `.app` on the Mac.
5. Start with no models or cached PCM.
6. Complete first-run with Turbo selected.
7. Disconnect the network.
8. Process WAV, MOV, and MP4 inputs.
9. Process a two-speaker file and a file with at least four speakers.
10. Cancel transcription and diarization once each, then retry.
11. Quit during a checkpointed transcription, reopen, and confirm it resumes.
12. Export TXT, JSON, SRT, and VTT.

Keep the private corpus outside Git. Match each source against the hash in its fixture
metadata. Do not put transcript text in general diagnostic logs.

## Measurements

The first Mac run establishes the baseline. Capture these values separately for a short
smoke file and a 30 to 60 minute recording:

| Measurement | Required evidence |
|---|---|
| Transcription | model, Metal or CPU, wall time, speech duration, real-time factor |
| Diarization | sherpa model, wall time, audio duration, real-time factor |
| Memory | peak RSS for the app and compute utility process, fallback occurrence |
| Reliability | completion, cancellation, resume, and repeated-run result |
| Output | timestamp validity, missing or duplicate spans, speaker count, review notes |

Do not require byte-for-byte equality with the Linux corpus. Metal and Vulkan can differ at
floating-point boundaries, and the Mac deliberately uses a different diarization engine.
Application-level invariants remain exact.

## Exit criteria

- [ ] Fresh setup defaults to Large V3 Turbo and downloads the Small recovery model.
- [ ] Packaged Whisper reports Metal use on the M1 test machine.
- [ ] Packaged sherpa diarization completes without Python or network access.
- [ ] Turbo memory exhaustion retries Small on Metal once and stays offline.
- [ ] The packaged utility process loads Whisper, sherpa-onnx, and better-sqlite3.
- [ ] Bundled FFmpeg probes and extracts each accepted container.
- [ ] The app uses native macOS data locations and leaves Linux paths unchanged.
- [ ] The full clean-room checklist passes on M1 with 8 GB RAM.
- [ ] Test notes include performance and memory measurements.
- [ ] Existing Linux unit tests and platform decisions remain intact.

## Deferred work

- Developer ID signing, notarization, DMG packaging, and automatic updates.
- Mac App Store sandboxing.
- Login items and broader macOS menu or Finder polish.
- Universal or Intel builds.
- Metal Sortformer or another accelerated diarization runtime.
- Public release automation and hosted artifacts.
