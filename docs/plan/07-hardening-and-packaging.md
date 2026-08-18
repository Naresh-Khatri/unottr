# Phase 07 — Hardening and packaging

**Goal:** make it survive contact with someone else's machine, and ship it.

**Depends on:** phase 06.

---

## Deliverables

- Complete failure taxonomy with user-facing messages.
- GPU OOM auto-fallback to CPU (decision #19).
- ffmpeg preflight check.
- Performance pass with recorded numbers.
- AppImage with bundled LGPL ffmpeg (decision #21).

## Tasks

### 1. Failure taxonomy

Every typed error from phase 00 gets a message, an action, and a decision about retrying.

| Error | User sees | Action | Retry |
|---|---|---|---|
| `FfmpegMissing` | ffmpeg is required and was not found | install hint + path picker | on fix |
| `NoAudio` | This file has no audio track | none, terminal | no |
| `Truncated` | Recording is incomplete or corrupt (often a crashed recorder) | none, terminal | no |
| `ModelMissing` | Model not downloaded | download button | on fix |
| `GpuOom` | (silent) | auto-retry on CPU | automatic, once |
| `Whisper` / `Diarize` | Transcription failed | Retry button | 2 auto, then park |
| `Io` | Cannot read the file — moved or permissions | Retry | 2 auto |

Rules: errors live on the recording row, never in a modal, never as a desktop
notification. The app must be silent while you are in a meeting.

### 2. GPU OOM fallback

Catch allocation failure from the Vulkan backend, mark that job CPU-only, retry once
automatically. Log it clearly — a machine where this fires every time means the default
model tier is wrong for that GPU, and the log is how you find out.

### 3. ffmpeg preflight

Check on startup and when a watch folder is added. Missing -> persistent banner with
per-distro install hints (`pacman -S ffmpeg`, `apt install ffmpeg`, `dnf install ffmpeg`)
and a manual path picker. Never queue jobs that are certain to fail.

### 4. Robustness pass

Run the full corpus in `/home/naresh` end to end and fix what breaks. Then the hostile
inputs, all of which must produce typed errors and no panics:

- 0-byte file; a `.mkv` that is actually text; a file with 6 audio tracks.
- A file that disappears mid-transcription.
- A full disk during PCM extraction (~115 MB/hour needs headroom).
- Two app instances started at once — single-instance lock, or WAL contention on the DB.
- A 4-hour recording (memory ceiling, segment count, UI virtualization).

### 5. Performance pass

Measure across the corpus and record in DESIGN.md:

- Real-time factor: CPU vs Vulkan, per model tier.
- Peak RSS and VRAM.
- Diarization time as a fraction of ASR time.
- Search latency with ~50 hours of transcript indexed.

These numbers drive the phase 04 backfill time estimate, so they are a feature input, not
a vanity metric.

### 6. Packaging

**ffmpeg**: swap `FfmpegCli`'s discovery to prefer a bundled binary, falling back to
`PATH`. Phase 01's trait means no call site changes.

> Licensing: bundle an **LGPL** build (configured **without** `--enable-gpl`). A
> GPL-configured ffmpeg would force GPL onto the whole application. Verify with
> `ffmpeg -version` and check the configuration flags of whatever build you ship.

**Artifacts**:

- **AppImage** (primary) — one file, ffmpeg inside, no dependency hell.
- Plain tarball / AUR `PKGBUILD` for local use, using system ffmpeg.
- Flatpak deferred; its runtime already carries ffmpeg, so revisit if AppImage friction
  shows up.

**Checks**: launch the AppImage on a machine with **no** Vulkan driver and confirm the CPU
fallback (this is the real test of decision #15), and on one with no `libayatana-appindicator`
to confirm the tray degradation from phase 06.

### 7. Release checklist

- [ ] `cargo clippy --workspace -- -D warnings`, `cargo test --workspace`, `tsc --noEmit`, lint.
- [ ] Corpus runs clean end to end.
- [ ] Hostile inputs produce typed errors, zero panics.
- [ ] AppImage runs on a clean machine with no toolchain.
- [ ] No-Vulkan fallback verified.
- [ ] No-tray degradation verified.
- [ ] Licence file, third-party notices (whisper.cpp, sherpa-onnx, ffmpeg, models).
- [ ] README: what it does, what it needs, privacy stance (nothing leaves the machine).

## Acceptance criteria

The definition of done for v1: **point the app at a folder, walk away, come back to a
searchable, speaker-labelled transcript with the video playable beside it** — on a machine
that is not this one.

## Out of scope

Everything in DESIGN.md's "Out of v1" list. Notably live transcription (decision #13),
which the chunked pipeline was built to accommodate later, and cross-meeting speaker
identity, which the stored embeddings were built to accommodate later.
