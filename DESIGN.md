# unottr — v1 design

An Electron desktop app that watches folders for meeting recordings and transcribes them
locally with speaker diarization. No cloud, no accounts, and no network call anywhere in
the transcribe/diarize path. The single exception is the **AI overview** (#25–#34), which
is opt-in, runs only when you click it, needs a key you supply, and sends transcript text —
never audio, never video.

## Settled decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Platform | Linux v1; stack keeps macOS/Windows open |
| 2 | Scope | watch -> transcribe -> diarize -> browse/read/search |
| 3 | Input | Any container ffmpeg reads; no conventions forced on users |
| 4 | Diarization bar | Anonymous speakers; naming one enrolls a voiceprint, so later recordings recognise them (see *Global identity*) |
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
| 25 | Inference | Bring your own endpoint: any OpenAI-compatible base URL, plus Anthropic and Mistral wires. Presets are a convenience, not a whitelist (superseded the pinned-Mistral choice) |
| 26 | Trigger | Explicit button per recording. Transcription stays automatic; AI never is |
| 27 | Placement | Satellite `overviews` table, **not** a pipeline stage — a network failure cannot mark a good transcript failed |
| 28 | Grounding | The model cites `segment_id`, never a timestamp; ids resolve locally, unknown ids are dropped |
| 29 | Vision | None. No keyframe extraction, no OCR, no image tokens |
| 30 | Visuals | `unottr://frame/<id>/<ms>` — lazy ffmpeg seek, cached; clicking seeks the player |
| 31 | Identity | `people.is_me` + `people.role`; role ranks and frames tasks, never filters them |
| 32 | Output | Title, TL;DR, sections, decisions, tasks — every line cited |
| 33 | Language | Summary in English; quoted phrases stay verbatim in their original language |
| 34 | Privacy | Transcript text only; key in `safeStorage`; opt-in dialog shows a real excerpt; pseudonymize toggle |
| 35 | Connections | One `ai_connections` row per endpoint, many allowed, one active. Consent, key, model, price and probe are columns on it, not global settings |
| 36 | Setup test | Four rungs — reachable, authorized, responds, structured — run and shown in order. A key check alone passes for models that then fail every generation |
| 37 | Structured output | Ladder: `json_schema` -> `json_object` + schema in prompt -> prompt only + tolerant parse. Probed once per connection, stored, never re-guessed per call |
| 38 | Base URL | One field, normalized in main: a pasted `/chat/completions`, a bare `localhost:11434`, or ollama's `/api` all resolve to the right root |
| 39 | Model list | Shown in the server's own order, never sorted — `/v1/models` puts the loaded or newest model first and alphabetical throws that away. Embedding/image ids sink to the bottom but are never hidden. LM Studio is asked over its own `/api/v0` first, the only place that says which model is *loaded* |
| 40 | Model choice | Always visible and always in a real picker. The list is fetched before the connection is saved, the test adopts whatever model it proved, and a connection with no model says so in amber everywhere it appears |
| 41 | A model fills itself in | "No model picked" is a warning nobody can act on, so it is repaired rather than reported: opening the Models dialog or the edit form lists the endpoint and adopts the head of that list for any connection missing one. Labels are numbered on save (`LM Studio 2`) when a derived one collides, since two identical rows are not a choice |
| 42 | Test owns one row | Test has to save before it can probe (the key and url are read back from the row), so the form remembers which row it created and every later press updates that one. A row that only exists because Test needed one is deleted again if the form is left without saving |
| 43 | Long meetings | A transcript larger than the model's window is split into overlapping windows, summarized one at a time and joined back up — sections keep the meeting's order, tasks and decisions deduplicate by the segment they cite, and title/tldr come from one small pass over the parts' own summaries. Citations are unaffected: every window carries real segment ids. Refusing was the old behaviour and it is wrong here — an 8k local server against an hour of audio is the normal case, not the edge |
| 44 | Context size is learned, not guessed | Taken from LM Studio's `loaded_context_length` (what the running instance was started with, routinely 16x smaller than the weights allow) when the model list is fetched. Failing that, it is read out of the server's own overflow 400 — the ceiling is the smaller of the two numbers every wording of that error names — stored on the connection, and the run is split and retried once. A number the user typed is never overwritten |
| 45 | The clock is sized to the prompt | A flat two-minute ceiling cannot tell a slow server from a hung one, and on a local model it is simply wrong: reading a full 8k window at ~25 tokens a second is over two minutes before the first token of answer exists, so every run it was asked to do got cancelled mid-prompt. The ceiling is now the floor plus what the prompt itself is worth — its size over a pessimistic throughput, plus room to write, capped at twenty minutes. A cloud provider never approaches it. A timeout is also no longer filed as "aborted": nobody chose it, and the advice for it is different |
| 51 | One colour per voice | Hue is the only chromatic thing in a greyscale ui, and it means exactly one thing: who is talking. A speaker's slot comes from their identity — the linked person if there is one, else the speaker row — never their position in a list, so a merge, a rename or a re-diarize doesn't reshuffle everyone's colour, and a voice the app already knows keeps the same colour in every recording. Eight hues at one lightness so no voice reads as louder; unattributed stays grey |
| 52 | Terminology keeps the source | Rules rewrite displayed segment text after diarization, never the recording or word timestamps. The first correction stores Whisper's original text in `segments.raw_text`; every later apply starts there, so editing, disabling or deleting a rule is reversible. A text change bumps `recordings.transcript_version`, refreshes FTS through its existing trigger and marks an older overview stale |

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
           recorded_at, status, error, attempts, last_chunk_idx, available,
           title, ai_title, transcript_version)
segments(id, recording_id, start_ms, end_ms, text, raw_text, speaker_id)
speakers(id, recording_id, label, display_name, person_id, embedding BLOB)
people(id, name, name_key UNIQUE, embedding BLOB, samples, is_me, role)
segments_fts    -- FTS5 over segments.text
watch_folders(id, path, track_rule, enabled)
settings(key, value)
stage_rates(key, rate, samples)   -- learned pipeline speed, see *Time remaining*
terminology_rules(id, source, replacement, case_sensitive, whole_word, enabled)
overviews(id, recording_id UNIQUE, status, error, error_kind, model, prompt_version,
          role_used, transcript_version, title, tldr, sections JSON, decisions JSON,
          tokens_in, tokens_out)                    -- see *AI overview*
tasks(id, recording_id, text, owner_speaker_id, start_ms,
      due_raw, due_date, status, user_edited)
overview_fts    -- FTS5, standalone; written by the overview writer, no triggers
```

`available = false` when the video is gone; transcript stays searchable, player disabled.

A `speakers` row is one recording's cluster, a `people` row is the person behind it. The
displayed name is `coalesce(people.name, speakers.display_name, speakers.label)`, so a
global identity outranks a name typed on one transcript.

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

## Global identity

A name is worth typing once. `people.embedding` is the running mean of every cluster
centroid a user has confirmed as that person; at the end of diarization each unnamed
cluster is matched against all of them and takes the name if it fits.

- **Threshold 0.45** cosine, against 0.6 within a recording. That cut compares fragments
  minutes apart through one mic; this one compares across sessions, rooms and months, where
  a false match silently puts words in someone's mouth.
- **Tie refusal.** Two people within 0.05 of a cluster are not tellable apart, so it stays
  anonymous rather than taking the marginally nearer one.
- **One person, one speaker.** Assignment is greedy by distance with a taken set: the
  runner-up cluster finds someone else or stays anonymous.
- **Only naming enrolls.** An auto-match never feeds itself back, so a wrong match cannot
  compound. Forgetting a person drops the voiceprint and un-names their speakers — the
  escape hatch when it does go wrong.
- **Forward only.** Existing recordings are not rescanned when a person is created;
  re-diarizing keeps whatever the user already decided, by label.

## Time remaining

Progress bars answer "how far", not "how long", and the difference between the two is a
factor of thirty here depending on the device. So the eta is built on the one number that
travels: **wall ms per ms of source audio**, per `stage:device:model`.

- **Learned, not tabulated.** `stage_rates` holds an EWMA (α 0.3) of that ratio, written
  when a stage finishes. The numbers in *Measured performance* below are only the priors a
  machine that has never run a job starts from; one recording replaces them with its own.
- **Blended while running.** A stage's live rate — elapsed over progress made — is what
  notices a loaded machine or a CPU fallback, but it is noise in the first few percent. It
  is weighted in linearly and takes over completely 20% into the stage.
- **The whole job, not the stage.** Every tick quotes the remaining stages too, so the
  number falls monotonically instead of resetting when diarization starts.
- **Nothing learned from a resumed run.** Its wall covers only the chunks it actually ran;
  clips under 30 s are skipped too, where process spawn dominates.
- **Minute-grained in the ui.** The estimate jitters by tens of seconds; a twitching number
  reads as broken even when it is right.

## AI overview

The one part of the app that talks to a server. It turns a finished transcript into a
title, a TL;DR, topic sections, the decisions, and a task list split into yours and
everyone else's — every line clickable back to the second it came from.

- **Opt-in twice over, per connection.** Nothing happens without an endpoint you added
  *and* a click on the recording — and consent is stored on the connection, because
  agreeing to send a transcript to a server on your own laptop is not agreeing to send it
  to somebody's cloud. Transcription stays automatic because it is free and local.
- **A satellite, not a stage** (#27). `recordings.status` never enters an AI state, so a
  dropped connection cannot bury a transcript that is perfectly fine. `overviews` carries
  its own `pending|running|done|failed|stale`, retryable from the tab it failed in. A
  `running` row older than the 120 s timeout is flipped to `failed` at startup — otherwise
  a mid-generate quit leaves a permanent zombie.
- **The model cannot invent a timestamp** (#28). It is handed segments as `[id] Name: text`
  and told to cite ids; ids are resolved to `start_ms` in one place, and a citation that
  does not resolve is dropped rather than rendered as a confident link into the wrong
  minute. This converts the category's signature failure — a summary that cites 32:14 where
  the video shows someone eating lunch — from an unfalsifiable hallucination into a
  validation check.
- **Role frames, never filters** (#31). `people.role` tells the model what you do so your
  items rank first and read usefully; it is explicitly told to extract every task
  regardless of owner. Filtering by role would let one bad speaker attribution silently
  delete a task you owned, and you would never know it was missing.
- **Ownership is a speaker, not a person.** A `people` row only exists once someone has
  been named, so a `people`-keyed owner would be NULL on nearly every task in a fresh
  library. Tasks point at `speakers.id`; "mine" is the join through
  `speakers.person_id = (select id from people where is_me = 1)`.
- **Regeneration is not destructive.** Prose is overwritten — at roughly 1.4¢ a run it is
  cheaper to remake than to version. Tasks are not: anything edited, checked, or dismissed
  survives, and only untouched open suggestions are replaced.
- **Any endpoint, no whitelist** (#25). A connection is a base URL, a wire (`openai`,
  `anthropic` or `mistral` — the request dialect, which a URL cannot tell you about), an
  optional key and a model id. The presets are chips that prefill those four fields; typing
  a URL by hand reaches exactly the same place. Ollama and LM Studio are knocked on when
  the add form opens, so the common case is "the one we found, already filled in".
- **The test has four rungs, not one** (#36). *Reachable*, *authorized*, *responds*,
  *structured* — run in order and shown in order, including the ones not reached. A key
  check alone is worthless here: a 3B model on a laptop happily accepts any key, answers
  "hi", and then fails every structured generation. The last rung is the one that predicts
  whether Generate will work, so it is the one that has to be tested.
- **A ladder, probed once** (#37). Endpoints disagree about how to be made to emit a
  schema, so the probe walks `json_schema` -> `json_object` + schema in the prompt ->
  prompt only, keeps the best rung that worked on the row, and generation uses it directly.
  Below the top rung the schema and one worked example ride in the system prompt, and the
  answer is unwrapped from whatever fence or preamble the model packaged it in — that
  packaging is not a schema failure, and treating it as one turns a working setup into
  "your model can't do this".
- **The url is normalized where it is used** (#38). People paste what their provider's curl
  example shows. `localhost:11434`, `http://localhost:11434/api`, and
  `https://api.anthropic.com/v1/messages` all resolve to the right root, in main, so the
  same rule applies to a typed URL and a preset alike.
- **Cost, for calibration.** A 33-minute meeting is ~20k tokens; on `mistral-large-2512`
  ($0.50/M in, $1.50/M out) that is about **1.4¢**, and a two-hour meeting about 4¢. On a
  local model it is zero, and unottr estimates nothing rather than showing a fake ¢ figure.
  Prices for known hosted ids are prefilled and editable; an unknown id is left unpriced.
  Everything goes in one call — there is no map-reduce and no summary-of-summaries quality
  loss — so a context that is too small is a *pre-flight* error (chars/4 plus a 3k output
  reserve, checked before anything is sent or spent), not a truncation nobody was told about.
- **No vision** (#29). Screenshots in the UI are not extracted or analysed — a bullet's
  cited millisecond is seeked out of the video on demand by `unottr://frame/<id>/<ms>` and
  cached. The picture is orientation; the click-to-seek is the payload. OCR of screen
  shares is the obvious next addition and this route is its hook.

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

Transcript editing, live/in-progress transcription, calendar/Zoom/Meet integration,
sharing, sync, mobile. Vision/OCR of screen shares, cross-recording task rollups, and local
inference are out of *this* phase but designed for — see `docs/plan/09-ai-overview.md`.

## Plan

See `docs/plan/` — one file per phase.
