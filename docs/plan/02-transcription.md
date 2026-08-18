# Phase 02 — Transcription

**Goal:** PCM in, timestamped text out — on the GPU when there is one, on the CPU when
there is not, resumable if the process dies.

**Depends on:** phase 01.

---

## Deliverables

- `whisper-rs` integration with a **runtime-selected** compute backend (decision #15).
- Chunked, VAD-aligned transcription with per-chunk DB checkpointing (decision #18).
- **Word-level timestamps** — phase 03 cannot split segments on speaker boundaries without them.
- Model manager: registry, download with progress, checksum verification.
- `unottr transcribe` CLI subcommand.

## Tasks

### 1. Backend selection — do this first

Decision #15 requires one binary that runs on a machine with no Vulkan driver. GGML links
Vulkan at build time unless backends are built as loadable shared objects
(`GGML_BACKEND_DL=ON`), which makes `ggml-vulkan.so` a runtime `dlopen`.

**Spike this before writing anything else in the phase.** Confirm that a build with
`GGML_BACKEND_DL` still starts on a machine with `libvulkan` absent. If the whisper-rs
bindings do not expose it cleanly, the fallback options are, in order of preference:

1. Weak-link `libvulkan` and probe with `dlopen` at startup.
2. Ship two artifacts (GPU / CPU) — violates the spirit of decision #15, so treat it as a
   last resort and record it in DESIGN.md if it happens.

Runtime selection: enumerate devices, require >= 2 GB free VRAM for `large-v3-turbo`, else
fall back to CPU. Expose the resolved device so settings and logs can show it.

> This box: RADV / Mesa 25.3.5 / Vulkan 1.4 / **12 GB VRAM**, `shaderc` + `glslang`
> installed. The GPU path will work here — the whole risk is on other people's machines.

### 2. Chunking

- Run VAD over the PCM, prefer whisper.cpp's built-in Silero VAD; `webrtc-vad` is the
  fallback if the bindings do not expose it.
- Build chunks of <= 30 s (whisper's window) whose boundaries **snap to silence**. Never
  cut mid-word.
- Drop chunks that are pure silence. This is the mitigation for whisper's well-known
  habit of hallucinating repeated phrases into dead air, and it is required, not optional
  — a 2-hour meeting has a lot of dead air.
- Chunk plan is deterministic from the PCM, so a resumed run produces identical boundaries.

### 3. Transcribe + checkpoint

For each chunk `i`, in one transaction:

```
INSERT INTO segments (recording_id, chunk_idx, start_ms, end_ms, text, words) ...
UPDATE recordings SET last_chunk_idx = i, stage_detail = '...', updated_at = ...
```

- Offset every timestamp by the chunk's absolute start.
- Enable token/word timestamps and persist them to `segments.words` as JSON.
- On resume, delete any segments with `chunk_idx > last_chunk_idx` (guards a crash between
  insert and update), then continue from `last_chunk_idx + 1`.
- Language: auto-detect, but expose a settings override — auto-detect on a short quiet
  opening chunk is a known failure mode.

### 4. Model manager

| Model | Size | Default |
|---|---|---|
| `large-v3-turbo-q5_k` | ~550 MB | yes |
| `medium-q5_0` | ~500 MB | |
| `small-q5_1` | ~180 MB | |

- Registry: name, URL, sha256, byte size. Download to the models dir with progress,
  verify the hash, atomic rename into place. Resumable via HTTP range.
- A partially downloaded or hash-mismatched file must never be loaded — delete and report.
- `ModelMissing` is a typed error the UI turns into a "download model" action in phase 06.

## Acceptance criteria

- [x] Backend spike resolved and written down before other work in this phase begins.
- [x] `unottr transcribe` produces sane segments for a real 34-minute recording from the corpus.
- [x] Forced CPU and GPU runs on the same file produce transcripts that agree closely by eye.
- [x] **Kill test**: `kill -9` mid-run, rerun, and it resumes at the checkpoint — no
      duplicated and no dropped segments. Assert the segment count matches an uninterrupted run.
- [x] A pure-silence PCM produces zero segments, not hallucinated text.
- [x] Word timestamps are present and monotonically increasing on every segment.
- [x] Corrupt model file is rejected with `ModelMissing`, not a crash.
- [x] Record real-time factor for CPU and GPU on one corpus file; put the numbers in DESIGN.md.

## Risks

- The `GGML_BACKEND_DL` story is the single biggest unknown in the project. It gates
  decision #15 and it is why the spike leads the phase.
- Vulkan `large-v3-turbo` on a 12 GB card should be far faster than realtime; if it is
  not, suspect the shader build rather than the model.

## Out of scope

Speakers of any kind. Every segment leaves this phase with `speaker_id = NULL`.

---

## Spike verdict — backend selection

**`GGML_BACKEND_DL` is unreachable through `whisper-rs`, and it is not needed.**

Unreachable, three independent blocks:

1. `whisper-rs-sys` build.rs hardcodes `.define("BUILD_SHARED_LIBS", "OFF")`.
2. Its cmake env passthrough forwards only `WHISPER_*` / `CMAKE_*` keys, so the flag
   cannot be injected without patching the crate.
3. ggml's `src/CMakeLists.txt`: `if (GGML_BACKEND_DL AND NOT BUILD_SHARED_LIBS)
   message(FATAL_ERROR ...)`.

Not needed, measured on a release binary linked with `features = ["vulkan"]`:

| Condition | Result |
|---|---|
| Driver present | `ggml_vulkan: 0 = AMD Radeon RX 6700 XT (RADV NAVI22)`, model on `Vulkan0` |
| Loader present, **no ICD** (`VK_DRIVER_FILES=/nonexistent.json`) | 1 device, 1 backend, `CPU total size = 147.37 MB`, transcribes fine |
| Loader **absent** (`bwrap --ro-bind /dev/null /usr/lib/libvulkan.so.1`) | does not exec: `error while loading shared libraries: libvulkan.so.1` |

`readelf -d` confirms the hard `DT_NEEDED libvulkan.so.1` — this is the loader, not a
driver, and it is vendor-neutral.

**Resolution:** ship one Vulkan-linked binary and bundle `libvulkan.so.1` (~450 KB) in the
AppImage (phase 07). Neither fallback from the plan is taken: no weak-linking, no second
artifact. `use_gpu(false)` still forces CPU with the device enumerated, so the runtime
device toggle works as designed.

### Fallout for the model registry

`large-v3-turbo-q5_0` measures **0.8× realtime on 12 CPU threads** — slower than the
meeting itself. The plan's "turbo is the default" only holds on the GPU path. The registry
carries a per-device default: turbo on GPU, `small` on CPU. Full numbers in DESIGN.md.

### whisper-rs 0.16 API notes

- Standalone Silero VAD is exposed (`WhisperVadContext`), so `webrtc-vad` is not needed
  and whisper's internal `enable_vad` is *not* used — it would chunk internally and defeat
  per-chunk checkpointing. We run VAD ourselves, then transcribe chunk by chunk.
- Timestamps (`t0`/`t1`, segment and token alike) are **centiseconds**, not ms.
- `set_abort_callback_safe` is **unusable**: it builds its trampoline for the concrete
  closure type but passes a `Box<dyn FnMut>` as user data, so the callback reads garbage
  and whisper aborts every encode with `-6` ("failed to encode"). Cancellation is checked
  between chunks instead — <= 30 s of latency, and no unsound FFI.
