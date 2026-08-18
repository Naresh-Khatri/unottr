# Phase 01 — Media pipeline

**Goal:** hand the pipeline any file a user owns and get back reliable metadata plus a
16 kHz mono PCM stream, with the right audio track chosen automatically.

**Depends on:** phase 00.

---

## Deliverables

- `MediaBackend` trait + `FfmpegCli` implementation (decision #21: system ffmpeg now,
  bundled later, behind one seam).
- `probe()` returning structured metadata for any container.
- Track selection implementing decision #14 (auto-detect + override).
- `extract_pcm()` with progress reporting and cancellation.
- `unottr probe` and `unottr extract` CLI subcommands.

## Tasks

### 1. The seam

```rust
pub trait MediaBackend: Send + Sync {
    fn probe(&self, path: &Path) -> Result<Probe>;
    fn extract_pcm(
        &self,
        path: &Path,
        stream_index: u32,
        out: &Path,
        progress: &dyn Fn(f32),
        cancel: &CancelToken,
    ) -> Result<()>;
}
```

Everything downstream talks to this trait, never to ffmpeg directly. Swapping a bundled
binary in phase 07 must not touch a single call site.

Binary discovery order: configured path in `settings` -> `PATH` -> error `FfmpegMissing`
carrying a distro-agnostic install hint (phase 07 surfaces it).

### 2. Probe

```
ffprobe -v quiet -print_format json -show_format -show_streams <file>
```

```rust
pub struct Probe {
    pub container: String,
    pub duration_ms: Option<u64>,
    pub audio: Vec<AudioStream>,   // index, codec, channels, sample_rate, title, language
    pub has_video: bool,
}
```

Rules:
- Zero audio streams -> `Probe` error `NoAudio`. Not a crash, a typed outcome.
- Missing/zero duration, or ffprobe non-zero exit -> `Truncated`. This is the OBS
  `.mp4`-crash case and it is expected to occur in the real corpus.

### 3. Track selection (decision #14)

```rust
pub enum TrackRule { Auto, Stream(u32), MicDesktop { mic: u32, desktop: u32 } }

pub enum Selection {
    Blind { stream: u32 },                       // one mixed track, diarize everything
    MicDesktop { mic: u32, desktop: u32 },       // mic is a known speaker
}
```

`Auto` heuristic, in order:

1. Exactly one audio stream -> `Blind { 0 }`. **This is the path all 10 existing
   recordings take** — get it right first.
2. Multiple streams, titles match `/mic|microphone/i` and `/desktop|system|speaker/i`
   (OBS writes track titles into MKV; MP4 usually loses them) -> `MicDesktop`.
3. Multiple streams, exactly one is mono and the rest stereo -> mono is the mic candidate,
   the first stereo is desktop -> `MicDesktop`.
4. Anything else -> `Blind { first stream }`.

Log the reason for the choice at INFO. When users report bad speaker labels, this line is
the first thing you will want.

The per-folder override from `watch_folders.track_rule` always wins over `Auto`.

### 4. Extraction

```
ffmpeg -nostdin -v error -progress pipe:1 -i <file> \
  -map 0:a:<i> -vn -ac 1 -ar 16000 -f s16le -acodec pcm_s16le <out.pcm>
```

- Parse `out_time_ms` from the `-progress` stream for the progress callback.
- ~115 MB per hour of audio. Write to the PCM cache dir, delete on pipeline completion
  **and** on failure — an orphaned 2-hour PCM is 230 MB of silent disk loss.
- `MicDesktop` extracts two PCM files; phase 03 consumes both.
- Cancellation kills the child process and removes the partial file.

## Acceptance criteria

- [x] `unottr probe` emits valid JSON for **every recording in `/home/naresh`**, with
      duration within 1% of `ffprobe`'s own `format.duration`.
- [x] A deliberately truncated MP4 (`head -c 50000000` of a real one) returns `Truncated`,
      not a panic.
- [x] A video file with no audio track returns `NoAudio`.
- [x] `unottr extract` produces a PCM whose length in samples matches the probed duration
      within 1%.
- [x] Unit tests for the `Auto` heuristic over synthetic `Probe` structs covering all four
      branches — no media files needed for these.
- [x] Cancelling mid-extract leaves no `.pcm` behind and no orphaned ffmpeg process.
- [x] `cargo clippy -- -D warnings` clean.

## Risks

- **MP4 drops track titles**, so branch 2 rarely fires for MP4 multi-track. Branch 3
  (mono-among-stereo) carries the real weight. Do not over-invest in title parsing.
- Users can hand this arbitrary junk — a `.mkv` that is actually a text file, a 0-byte
  file, a growing file. All must return typed errors.

## Out of scope

Transcription, diarization, the watcher. This phase only turns files into PCM.

---

## Outcome

Done. 21 tests pass; `clippy -D warnings` and `fmt --check` are clean.

**Corpus is 184 recordings, not 10.** All are MP4, all single-track, so branch 1 of the
`Auto` heuristic is the only one the real corpus exercises. Branches 2-4 are covered by
unit tests over synthetic `Probe` structs plus one generated three-track MKV.

Measured against the corpus:

| | count |
|---|---|
| probed cleanly, duration drift 0% | 178 |
| `Truncated` (mp4 with no moov atom) | 5 |
| `NoAudio` (33 KB video-only stub) | 1 |

The five truncated files are real interrupted OBS recordings the user already had — the
`.mp4`-crash case from the design is not hypothetical, it is 2.7% of this corpus. Phase 04
must not retry these forever.

Extraction throughput on this machine: a 3h13m recording (11557s) extracts in **11s**
wall-clock, duration accurate to 0.1s (0.001%). A 34-minute one takes ~2s. Extraction will
never be the bottleneck; transcription will.

### Findings worth carrying forward

- **`out_time_ms` is a misnomer.** ffmpeg's `-progress` stream reports microseconds under
  both `out_time_us` and `out_time_ms`. Parsing `out_time_ms` as milliseconds gives
  progress 1000x too fast.
- **ffprobe cannot distinguish "missing file" from "not media"** — both exit non-zero with
  `Invalid data found`. `probe()` stats the file first so a missing path reports as such.
- **A truncated MP4 and a text file named `.mp4` are indistinguishable** to ffprobe (both
  say `moov atom not found`). We classify both as `Truncated`; harmless in practice.
- **stderr must be drained on its own thread** while reading the `-progress` stdout stream,
  or a chatty ffmpeg fills the pipe and both sides block forever.
- Attached cover art is a video stream to ffprobe; `has_video` ignores streams with
  `disposition.attached_pic`.

### Deviations from the plan

- Binary discovery is `UNOTTR_FFMPEG`/`UNOTTR_FFPROBE` env override -> `PATH`. The
  settings-table path lands in phase 06 when settings exist; `FfmpegCli::new` is the seam.
- `unottr extract` on a `MicDesktop` selection extracts the mic track only. Two-file
  extraction belongs to phase 03, which is what consumes both.
