# unottr — v1 design

An Electron desktop app that watches folders for meeting recordings and transcribes them
locally with speaker diarization. No cloud, no accounts, no LLM.

## Settled decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Platform | Linux v1; stack keeps macOS/Windows open |
| 2 | Scope | watch -> transcribe -> diarize -> browse/read/search |
| 3 | Input | Any container ffmpeg reads; no conventions forced on users |
| 4 | Diarization bar | Anonymous speakers + per-recording rename |
| 5 | Speed | Batch background job |
| 6 | Shell | Electron 43 (was Tauri v2 — see *Why Electron* below) |
| 8 | ASR | whisper.cpp via `@fugood/whisper.node` + the `-linux-x64-vulkan` prebuild |
| 9 | Diarization | sherpa-onnx via `sherpa-onnx-node` + `sherpa-onnx-linux-x64` (no Python) |
| 10 | Ingest | Dedicated watch folders, 3-stage completion check, prompted backfill |
| 12 | Playback | Video, click-to-seek |
| 13 | Real-time | Out of v1; pipeline chunked so it drops in later |
| 14 | Tracks | Auto-detect with per-folder override |
| 15 | GPU | Runtime-loaded Vulkan, auto CPU fallback |
| 16 | Model | `large-v3-turbo` Q5_K default, switchable, downloaded on first run |
| 17 | Storage | SQLite only + export action; embeddings stored from day one |
| 18 | Queue | Serial worker, per-chunk checkpointing |
| 19 | Failures | Inline row status + retry; GPU OOM auto-retries on CPU |
| 20 | Background | Tray icon, close keeps watching, opt-in autostart |
| 21 | Deps | ffmpeg behind one module (bundled copy first, then PATH); AppImage + bundled LGPL ffmpeg to distribute. Playback is Chromium's own decoders, so no GStreamer |
| 22 | Identity | Path + cheap fingerprint — size + sha256 of the first and last 1 MiB (was blake3; `node:crypto` costs no dependency and both are 32 bytes, so the schema is unchanged); transcripts outlive deleted videos |
| 23 | Embeddings | pyannote seg-3.0 + 3D-Speaker CAM++ (`campplus-zh-en`, 192-dim) |
| 24 | Clustering | Unknown speaker count; two-stage fragment + average-linkage, see *Diarization* |

## Architecture

```
+--- renderer (Chromium) ---+       +--- main process (node) ----+
|  React + Vite UI          | <---> |  ipc handlers, events      |
|  <video> on unottr://     |  ipc  |  watcher, job queue        |
+---------------------------+       |  SQLite (better-sqlite3)   |
                                    +----------------------------+
                                       |                  | fork
                                    ffmpeg        +--- utilityProcess ---+
                                  (subprocess)    | transcribe, diarize, |
                                                  | merge — per job      |
                                                  +----------------------+
                                                     |              |
                                               whisper.cpp     sherpa-onnx
                                             (napi, Vulkan)  (segment + embed)
```

Three source trees, one package:

- **`src/main`** — everything stateful: db, watcher, queue, ipc, tray, window. Nothing here
  imports React; the pipeline modules avoid `electron` imports so tests can drive them
  headless.
- **`src/worker`** — the compute half: transcribe, diarize, merge. Forked as a
  `utilityProcess` per job, so a native crash kills one job and not the app.
- **`src/renderer`** — the UI, which sees only the typed ipc client and `unottr://` media
  urls. It never handles a filesystem path.

### Why Electron

Tauri v2 shipped v1 up to phase 07 and worked. It was replaced for one reason: playback.
WebKitGTK decodes through the host's GStreamer plugins, so `<video>` on a real recording
depended on which codecs the user's distro happened to install — and bundling GStreamer to
fix that costs more than Chromium does. Electron carries its own decoders, which removes
the whole class of problem. The second-order win is a single language: the pipeline, the
shell and the UI are all TypeScript, so there is one toolchain and one test runner.

## Pipeline

Each stage is a persisted queue state, so a crash resumes at a boundary.

1. **Discover** — chokidar's `awaitWriteFinish` (writer stopped and the size held still),
   then a second size-stable poll, then `ffprobe` parses **and reports a duration**. All
   must pass before queueing; the duration check is the one that catches a file the OS
   already called finished.
2. **Probe** — duration, container, audio stream list. Apply the track rule.
3. **Extract** — ffmpeg -> 16 kHz mono s16le PCM in cache (~115 MB/hour, deleted after).
4. **Transcribe** — whisper.cpp over ~30s VAD-aligned chunks. Each completed chunk is
   written to the DB immediately. This is the checkpoint.
5. **Diarize** — sherpa-onnx segmentation + embeddings, clustered over the **entire**
   recording. Deliberately not chunked: clustering is global.
6. **Merge** — assign each transcript segment the speaker whose turn overlaps it most;
   split a segment when a speaker boundary falls inside it (needs word timestamps).
7. **Finalize** — persist speakers + embeddings, index FTS5, delete temp PCM.

### Track rule

- 1 audio stream -> blind diarization on it.
- N streams -> inspect stream titles and channel layouts (a mono stream among stereo
  ones is likely a mic). If confident, treat the mic track as a known speaker and
  diarize only the desktop track. Unsure -> stream 0.
- Per-folder override in settings.

## Data model

```sql
recordings(id, path, fp_size, fp_head, fp_tail, container, duration_ms,
           recorded_at, status, error, attempts, last_chunk_idx, available)
segments(id, recording_id, start_ms, end_ms, text, speaker_id)
speakers(id, recording_id, label, display_name, embedding BLOB)
segments_fts    -- FTS5 over segments.text
watch_folders(id, path, track_rule, enabled)
settings(key, value)
```

`available = false` when the video is gone; transcript stays searchable, player disabled.

## Known risks

- ~~**Vulkan packaging**~~ — resolved in phase 02, see *Vulkan packaging* below.
- ~~**Diarization quality**~~ — resolved in phase 03, see *Diarization* below. sherpa
  embeddings survive real Meet/Zoom AEC; the pyannote sidecar fallback is **not** needed.
- **Whisper hallucination on silence** — VAD gating in stage 4 is required, not optional.
- **Truncated `.mp4`** from OBS crashes fails at stage 1's ffprobe check. Correct
  behaviour; those files are genuinely unrecoverable.
- **Silero VAD must run on CPU** (`useGpu: false`). On the Vulkan backend it aborts from
  inside ggml — a SIGABRT, not a catchable exception, so it takes the process with it. Only
  the VAD is pinned; transcription still runs on the GPU. This is on its own the reason
  compute runs in a forked `utilityProcess` rather than in main.
- **Three time units cross the native boundary.** whisper's `transcribe()` returns
  **milliseconds**, its VAD returns **centiseconds**, and sherpa's `process()` returns
  **seconds as floats**. Mixing any two is silently wrong by 10× or 100×, and the output
  still looks plausible. Rule: conversion happens at the native call site and nowhere else;
  everything crossing a module boundary is milliseconds.
- **`onProgress` from whisper fires only 0 and 100**, and sherpa has no progress callback
  at all. Job progress is derived from completed chunks over total chunks; the diarize
  stage reports a stage change and then nothing until it returns.

## Vulkan packaging

Resolved by the phase 02 spike, and unchanged by the move to Node: the prebuilt
`@fugood/node-whisper-linux-x64-vulkan` addon has the same hard `DT_NEEDED libvulkan.so.1`,
plus a `RUNPATH` pointing at its build machine's SDK. `scripts/fetch-vulkan-loader.sh`
stages the loader and `electron-builder.yml` puts it next to the electron binary, which is
on the AppImage's `LD_LIBRARY_PATH` — `LD_LIBRARY_PATH` is read at process start, so no
amount of `process.env` from js would do it.

The phase 02 findings, kept because they are why the conclusion is what it is.
`GGML_BACKEND_DL` was **unreachable** through `whisper-rs` and turns out to be unnecessary.

Why unreachable:

- `whisper-rs-sys`' build script hardcodes `BUILD_SHARED_LIBS=OFF` and emits
  `rustc-link-lib=static=ggml-vulkan` + `rustc-link-lib=vulkan`.
- Its cmake env passthrough only forwards keys prefixed `WHISPER_` or `CMAKE_`, so
  `GGML_BACKEND_DL` cannot be injected from the outside.
- ggml's own cmake refuses anyway: `GGML_BACKEND_DL requires BUILD_SHARED_LIBS`.

Why unnecessary — measured, not assumed:

- The linked binary carries a hard `DT_NEEDED libvulkan.so.1`. Hiding the loader
  (`bwrap --ro-bind /dev/null /usr/lib/libvulkan.so.1`) stops it from exec'ing at all.
- With the loader present but **no ICD driver** (`VK_DRIVER_FILES=/nonexistent.json`),
  whisper enumerates 1 device / 1 backend, loads the model to CPU, and transcribes
  correctly. No crash, no warning.

So decision #15 stands without forking the bindings: **bundle the vendor-neutral
`libvulkan.so.1` loader (~450 KB) in the AppImage**. GPU where a driver exists, CPU where
it does not, one artifact. Only the loader is bundled — never an ICD.

## Diarization

Resolved by phase 03 on three real corpus recordings. **sherpa-onnx is sufficient; the
pyannote Python sidecar is not needed** — decision #9 ("no Python") stands.

### The problem sherpa hands you

sherpa's `FastClustering` is **complete-linkage** over cosine dissimilarity: it merges two
groups only when *every* cross-pair is within threshold. One noisy turn (a cough, a
cross-talk overlap, AEC ducking) is enough to keep a speaker's turns apart, so a single
person shatters into many pure fragments. Run blind, file 1 came out at **124 speakers**.

Complete-linkage's conservatism is the whole reason it over-splits — but it also means the
fragments it produces are *pure*: it never merges two real people into one cluster. So we
keep it, tightened, and rejoin its fragments ourselves.

### Two-stage clustering (unknown k)

1. **Fragment** — run sherpa at a deliberately tight `FRAGMENT_THRESHOLD = 0.5`. Yields
   many small, speaker-pure fragments.
2. **Rejoin** — embed each fragment by its centroid, then agglomerate with our own
   **average-linkage (UPGMA)** at `DEFAULT_THRESHOLD = 0.6`. Average-linkage tolerates the
   one bad turn that broke complete-linkage, so a speaker's fragments merge back.
3. **Prune** — a cluster with less than `MIN_SPEAKER_MS = 10 s` of total speech is a
   mis-embedded scrap (a stray "yeah", an all-zero centroid from a too-short window); fold
   its turns into the nearest real speaker by time.

Fixed-k mode (caller supplies a count) skips all three and trusts sherpa — the rejoin/prune
heuristics only run in unknown-k mode.

### Evidence

| File | Kind | Speakers | Per-speaker turns | Ground truth |
|---|---|---|---|---|
| 1 | Standup | **4** | 455 / 76 / 29 / 8 | ~4 ✓ |
| 2 | Audit review | **6** | 213 / 132 / 103 / 77 / 37 / 23 | multi-party, coherent ✓ |
| 3 | 2-person call | **2** | 119 / 35 | 2 ✓ |

All clusters clear the 10 s floor with room (file 2's smallest = 85 s). Spot-checked turn
boundaries land on natural conversational transitions — questions flip to answers,
back-channels ("Yeah.") with no clear cluster are left unattributed (NULL) rather than
force-assigned. File 2 code-switches English/Malay across distinct speakers and still
separates cleanly, which is the AEC-degradation risk failing to materialise.

The corpus is exactly the feared input — laptop-mic Meet/Zoom with AEC and noise
suppression — and the embeddings stay separable. No pyannote.

### Merge

Per transcript segment: overlap-duration vs every turn, assign argmax. If the top two
overlaps are within 20 % **and** a turn boundary falls strictly inside, split at the nearest
**word** boundary and assign each half independently. No overlapping turn -> `speaker_id`
NULL. Splits are recorded via `segments.split_of` so re-diarizing rejoins the pieces first
and never fragments further (idempotent).

## Measured performance

5 minutes of a real corpus recording. RX 6700 XT (RADV, Navi22) vs 12 CPU threads.

| Model | GPU | CPU |
|---|---|---|
| `base.en` | 115× realtime (2.6 s) | 6.7× (45.0 s) |
| `large-v3-turbo-q5_0` | 39× realtime (7.7 s) | **0.8×** (388.5 s) |

**`large-v3-turbo` is slower than realtime on CPU.** A 2-hour meeting would take ~2.5
hours. The default model therefore depends on the resolved device: turbo on GPU, `small`
on CPU. Extraction (phase 01) is ~1000× realtime and never the bottleneck.

End of phase 02, whole pipeline on a 33-minute meeting (2010 s, 1760 s of it speech after
VAD, 100 chunks):

| Run | Wall | RTF over speech |
|---|---|---|
| GPU, `large-v3-turbo-q5_0` | 82.6 s | **21.3×** |
| GPU, `small-q5_1` | — | 38.6× (measured on a 2-min clip) |
| CPU, `small-q5_1` | — | **1.1×** (same clip, 12 threads) |

`small` on CPU is barely faster than the meeting itself, so the CPU path is a fallback, not
a comfortable default. `base.en` is the only genuinely fast CPU option (6.7×) but it is
English-only, and the corpus is not — so `small` stays the CPU default and the real answer
is "have a GPU".

Diarization (phase 03), the three corpus files, CPU-only (sherpa-onnx has no GPU path here):

| File | Speech | Wall | RTF |
|---|---|---|---|
| 1 | ~33 min | 415.6 s | 4.8× |
| 2 | ~38 min | 494.2 s | 4.6× |
| 3 | ~9 min | 122.6 s | 4.7× |

The fragment + rejoin second pass roughly doubles wall time over a single sherpa pass
(~4.7× vs ~6.4× realtime) — accepted for correctness. Still comfortably faster than
realtime, and it runs after transcription in the same background job.

### Phase 07: memory and diarization-vs-ASR cost

Light pass, same hardware, a 3-minute real-recording clip (163 s of speech after VAD),
`small` model, via the isolated CLI so nothing else was competing for the GPU:

| Stage | Wall | RTF | Peak RSS |
|---|---|---|---|
| Transcribe, CPU | 118.9 s | 0.9× | ~608 MB |
| Transcribe, GPU | 4.6 s | 35.8× | ~128 MB |
| Diarize (CPU-only) | 25.4 s | 7.1× | ~245 MB |

Peak RSS stays well under a gigabyte even for the CPU path (whisper.cpp's largest resident
buffers are the model weights themselves, already sized by the tier table above); nothing
here is the memory-bounded case decision #22 already worried about (that's the ingest
watcher's directory-scan bookkeeping, not the ASR/diarization workers). VRAM wasn't
measurable in this environment (no `nvidia-smi`/`rocm-smi` equivalent for this AMD card
that gives a single-shot per-process read); peak RSS is the portable number instead.

Diarization's cost is CPU-bound and roughly fixed per minute of audio regardless of what
device ASR used, so **what fraction of the pipeline diarization eats depends entirely on
where ASR ran**: against this clip's GPU transcribe pass (4.6 s) diarization is ~5.5× the
ASR time — the dominant cost of the job. Against the CPU transcribe pass (118.9 s)
diarization is only ~21% on top. In other words: get a GPU and diarization becomes the
long pole; stay on CPU and it is not.

Search latency at scale: a synthetic 30,000-segment / 120-recording corpus (roughly the
scale of ~50 hours of transcript at typical segment density) inserted into `segments_fts`
(the real production schema, decision — SQLite FTS5, `unicode61`). Four representative
phrase queries with `snippet()` and a rank-ordered `LIMIT 50` each returned in 2-7 ms.
Full-text search is not a scaling concern at any realistic library size for this app.

## Out of v1

Summaries or any LLM, transcript editing, live/in-progress transcription, cross-meeting
speaker recognition, calendar/Zoom/Meet integration, sharing, sync, mobile.

## Plan

See `docs/plan/` — one file per phase.
