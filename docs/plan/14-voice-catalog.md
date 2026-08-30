# Phase 14: Speech voice catalog

**Goal:** add useful US and UK English choices without increasing the application download or
complicating the existing single-voice settings flow.

**Default:** Lessac remains selected. Every voice remains an optional, verified download.

## Measured artifact choice

Benchmarked with `sherpa-onnx-node` 1.13.6, two CPU threads, and the Phase 13 harness on an
AMD Ryzen 5 3600. Medians use five warm runs.

| Voice | Artifact | Load | First response | Warm median | RTF | First chunk |
|---|---|---:|---:|---:|---:|---:|
| Kristin medium | full | 1.53 s | 374 ms | 346 ms | 0.057 | 99 ms |
| Amy medium | full | 1.51 s | 445 ms | 416 ms | 0.060 | 115 ms |
| Cori medium | full | 1.56 s | 421 ms | 457 ms | 0.075 | 107 ms |
| Alan medium | full | 1.40 s | 406 ms | 391 ms | 0.056 | 104 ms |

Int8 downloads were about 21 MB instead of 67 MB, but synthesis was 4 to 5 times slower on
this CPU. Cori high took 2.11 seconds warm; Cori medium took 457 ms. Use the full medium
artifacts for all four voices.

## 14.1 Single-speaker voices

- [x] Benchmark full and Int8 artifacts.
- [x] Select Kristin, Amy, Cori medium, and Alan full-precision models.
- [x] Pin archive size, archive hash, entry counts, extracted bytes, model hash, and tokens hash.
- [x] Add US and UK locale labels to the existing catalog.
- [x] Keep onboarding, Settings, download progress, preview, removal, and playback data-driven.
- [x] Verify real installation for every new pinned archive.
- [x] Run typecheck and the complete test suite.
- [ ] Repeat the benchmark and packaged-app smoke test on macOS arm64.

## 14.2 Curated LibriTTS-R speakers

Treat LibriTTS-R as a separate change. It is one downloaded model with 904 speaker IDs, not
904 independent downloads.

- Add a validated `tts_speaker_id` setting with a safe default.
- Keep `tts_voice_id` as the downloaded model identity.
- Curate 8 to 12 speaker IDs after generating identical previews for each candidate.
- Show the speaker selector only when the chosen model has multiple speakers.
- Switching speaker IDs should stop current playback but reuse the loaded model.
- Test invalid speaker IDs at the settings and worker boundaries.
- Benchmark the full and Int8 model before selecting the shipped artifact.

Do not expose all 904 speaker IDs, add a remote catalog, or change the Lessac default in this
phase.

## Exit criteria

- Seven single-speaker voices are selectable and independently downloadable.
- Missing voices add zero bytes to the application package.
- Installed indicators and testing work for every voice.
- A corrupt or unexpected archive cannot install.
- Voice switching cannot mix audio from two models.
- Benchmark previews and notices match the pinned artifacts.
- LibriTTS-R lands only after its speaker shortlist and settings contract are tested.
