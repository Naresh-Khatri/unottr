# Phase 13: Ask read-aloud

**Goal:** let Ask read completed assistant answers aloud with a local, downloadable
Piper-compatible voice while the text remains the primary response.

**Depends on:** the current Ask implementation, settings store, model-download progress
events, Electron utility-process pattern, and `sherpa-onnx-node` runtime.

**Platforms:** Linux x64 and macOS arm64, matching the app's current release targets.

**Implementation status, 2026-08-30:** complete in source and verified on Linux with
`pnpm typecheck` and the full test suite. macOS, packaged-artifact, contention, and manual UI
checks remain release gates.

**Agreed with the user on 2026-08-30** through a grilling session. The decisions in this
document are settled. Do not reopen them during implementation unless a measured spike proves
that one cannot work.

## Product decisions

- Ask keeps its current complete-response flow. This phase does not add provider response
  streaming.
- Once the final answer is visible, read it one sentence at a time.
- `Read answers aloud` starts enabled and persists after the user changes it. It remains inert
  until the selected voice is installed.
- Each assistant message has Read, Replay, and Stop actions.
- Speak normal prose and headings. Skip fenced code, tables, raw URLs, and citation metadata.
  Read Markdown link labels without reading their target URLs.
- Only one narration may be active. A new narration replaces the old one.
- Stop narration when the user submits another question, changes threads, leaves Ask, opens
  recording media, disables read-aloud, removes the voice, or closes the app.
- A TTS failure never fails, delays, or removes the text response.
- Use the operating system's default audio output. Do not add an output-device picker.
- Version one has three pinned English voices: Norman, LJSpeech, and Lessac. It has no remote
  voice catalog, speed control, pitch control, word highlighting, audio cache, or saved speech
  files.
- Do not bundle a voice. Offer an optional download in onboarding and Settings.
- The onboarding Speech step is optional. Ask works normally when it is skipped or fails.
- Reuse the existing `sherpa-onnx-node` VITS support for Piper-compatible voices. Do not add
  the Piper Python package, Piper executable, loopback HTTP server, or another native engine.

## Why Sherpa runs the Piper voice

The application already ships `sherpa-onnx-node` and its native packages for Linux x64 and
macOS arm64. Its `OfflineTts` VITS configuration accepts Piper model files, tokens, and
espeak-ng data. Reusing it avoids these costs:

- bundling Python or a new per-platform Piper executable;
- starting a loopback HTTP service;
- loading native inference code in the renderer or main process;
- adding the current Piper engine's GPL distribution obligations;
- maintaining another packaging path for platforms the app already supports.

Run TTS in a dedicated, long-lived Electron utility process. Native inference stays outside
the main and renderer processes, and the loaded voice remains warm between answers.

## Current code constraints

- `src/renderer/src/ui/Ask.tsx` awaits `askSend()` and receives a complete `AskThread`. It
  does not receive answer text deltas.
- `src/main/ai/ask.ts` generates, grounds, saves, and returns the complete answer in one
  operation.
- `AskMessage.text` in `src/shared/ipc.ts` is the correct narration input. It excludes inline
  citation UI and source metadata. Do not scrape the rendered DOM.
- Ask cancellation currently stops model generation only. Speech cancellation is a separate
  lifecycle and command path.
- `src/worker/index.ts` and `src/main/ingest/pipeline.ts` already isolate native inference in
  Electron utility processes.
- The settings table is key-value based. Adding one validated setting requires no migration.
- The current model downloader verifies and atomically installs flat files. A TTS voice is a
  nested archive, so it needs a focused installer rather than a false fit in the ASR catalog.
- No safe `.tar.bz2` extractor exists in application code. Declare all extraction libraries
  as direct production dependencies.

## Target architecture

```text
Ask receives final assistant message
              |
              v
renderer speech controller cleans and splits message.text
              |
              v
typed TTS IPC command with request id and sentences
              |
              v
main-process TTS manager owns one warm utility process
              |
              v
sherpa OfflineTts generates one sentence at a time
              |
              v
typed audio events return Float32 samples and sample rate
              |
              v
renderer AudioContext schedules sentence buffers on default output
```

The utility process may use Sherpa's progress callback internally to notice cancellation, but
version one emits sentence-sized audio events. This keeps the public protocol small and avoids
turning low-level model chunks into UI state.

Use a monotonically changing `request_id`. Main, worker, and renderer discard audio from an
older request. Latest request wins everywhere.

## Implementation order

### 13.1 Prove the exact runtime and choose a voice

Do this spike before building product UI. The prior benchmark used Piper's own runtime and
Lessac. It does not prove the same latency through Sherpa.

Test these public-data candidates through the installed `sherpa-onnx-node` version:

- `en_US-ljspeech-medium`, trained from scratch on public-domain LJSpeech data;
- `en_US-norman-medium`, trained from scratch on public-domain LibriVox recordings.

Lessac uses the Blizzard 2013 dataset under separate dataset terms. Its source and terms stay
visible in `THIRD-PARTY.md`; the user explicitly chose to include it on 2026-08-30.

For both candidate voices, record:

- upstream URL, archive byte size, SHA-256, model license, dataset source, and attribution;
- load time and peak utility-process RSS;
- time to first sentence, complete synthesis time, audio duration, and real-time factor;
- cancellation during a long sentence and between sentences;
- repeated warm runs;
- behavior while transcription or diarization is active;
- one Linux x64 run and one macOS arm64 run;
- short audio previews for a human voice-quality choice.

Select one candidate and pin its immutable URL, byte size, SHA-256, extracted directory name,
required files, sample rate, speaker id, and generation parameters in the TTS voice spec.

Acceptance:

- The selected voice loads and synthesizes intelligible English on both release platforms.
- Cancellation ends active generation without killing the application.
- The selected archive has documented model and training-data provenance suitable for the
  intended distribution.
- The plan records the new measured baseline. Do not promise the Piper benchmark's 94 ms
  result unless the Sherpa path reproduces it.

#### Linux spike, 2026-08-30

The exact application runtime works. The benchmark used `sherpa-onnx-node` 1.13.6 at commit
`1cb484af`, ONNX Runtime 1.27.1, Node 23.11.1, and two CPU threads on an AMD Ryzen 5 3600.
Sherpa 1.13.6 includes the merged async callback lifetime fix from upstream PR 3781.

| Voice | Load | First complete answer | Warm median | Warm RTF | First native chunk | Final RSS |
|---|---:|---:|---:|---:|---:|---:|
| LJSpeech medium | 1.40 s | 402 ms | 388 ms | 0.058 | 108 ms | 393 MiB |
| Norman medium | 1.53 s | 359 ms | 327 ms | 0.061 | 89 ms | 382 MiB |
| Lessac medium | 0.85 s | 306 ms | 306 ms | 0.055 | 80 ms | 375 MiB |

All three voices synthesized at 22,050 Hz and cancelled at the first native progress callback
without crashing. Twenty repeated warm runs stayed near the same latency. RSS rose as ONNX
Runtime filled its memory arena, then levelled off near 300 MiB before the long and cancellation
probes. This confirms that the long-lived model belongs in its own utility process.

The Electron utility process must call `generateAsync` with `enableExternalBuffer: false`.
Electron rejects N-API external buffers, so Sherpa's default zero-copy result fails during
promise settlement. The copied-buffer result is then safe to send to the renderer.

Lessac is the default. Norman remains available because it was fast for the complete sentence,
its model card identifies the LibriVox source recordings as public domain, and its male voice is a
closer replacement for the Lessac preview used in the earlier Piper benchmark.

Future Piper comparisons should run `pnpm benchmark:tts -- --model-dir DIR --voice-id ID
--output-dir DIR --json FILE` and write the generated WAV and JSON files to a temporary directory
outside the repository. Benchmark outputs are disposable and should not be committed.

All three voices are pinned as selectable downloads. Each voice has independent status,
download progress, verified installation, removal, and test playback. A missing selected voice
pauses narration without changing the saved read-aloud preference.

Pinned Norman archive:

- URL: `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-norman-medium.tar.bz2`
- bytes: `67,203,672`
- SHA-256: `1f32065d480abe9abc7c7f91442125d0b34c1cc065d1e600466cac408eabf3b8`
- extracted files: `359`, totalling `81,529,594` bytes before the local manifest
- ONNX SHA-256: `fa06b6b8b280e176b17f8424e05ca12d0223eeac9a31c87230937fe7120fbe2a`

Still required before release: the same runtime check on macOS arm64, packaged-app checks on
both platforms, and contention measurements while transcription and diarization run.

### 13.2 Add a verified voice installer

Create a focused TTS model area under the existing models directory, for example:

```text
<models>/tts/<voice-id>/
  model.onnx
  tokens.txt
  espeak-ng-data/
  manifest.json
```

Add a TTS voice spec and status module under `src/main/tts/`. The spec owns every remote and
local fact. UI code must not contain URLs, hashes, archive paths, or byte counts.

The installer must:

1. Download the pinned upstream `.tar.bz2` archive to a dedicated `.part` path.
2. Resume only when the server and local partial file support a safe byte-range continuation.
3. Verify exact byte size and SHA-256 before extraction.
4. Extract into a new sibling staging directory.
5. Reject absolute paths, `..` traversal, symlinks, hardlinks, devices, and entries outside the
   one expected top-level directory.
6. Reject unexpected entry counts or paths when the selected archive has a fixed manifest.
7. Verify `model.onnx`, `tokens.txt`, and the required espeak-ng data before installation.
8. Write a local manifest containing the voice id, source URL, hash, installed files, and
   version.
9. Atomically rename staging to the final voice directory.
10. Remove staging after errors. Preserve a valid `.part` file after cancellation when resume
    is possible.

Declare the bzip2 and tar-streaming packages as direct production dependencies. Keep the
extractor small and local to TTS. Do not shell out to a host `tar` command and do not import
transitive build dependencies.

Expose dedicated commands instead of widening the ASR model catalog:

- `tts_voice_status`
- `download_tts_voice`
- `cancel_tts_voice_download`
- `remove_tts_voice`

Reuse the existing model-download progress map and event transport so progress survives
renderer navigation and appears in `QueueShelf`. Give the TTS download a friendly label.

Removal must first stop narration and shut down the TTS utility. Delete only the dedicated
voice directory and its partial or staging paths. Then set read-aloud to disabled. Never accept
an arbitrary path from the renderer.

Update disk-usage reporting to count the nested TTS directory recursively. The current flat
model scan would otherwise under-report storage.

Acceptance:

- Download, cancellation, resume, checksum failure, extraction failure, retry, and removal
  have deterministic states.
- An archive containing traversal or link entries cannot write outside staging.
- A crash before atomic rename leaves either the previous complete voice or no installed
  voice, never a half-installed final directory.
- Removing a voice cannot delete any ASR, support, recording, or cache files.

### 13.3 Define settings and IPC contracts

Extend `Settings` in `src/shared/ipc.ts` with one boolean, named consistently with the existing
settings keys, for example `ask_speak_answers`.

Add validated shared types for:

- voice installation status;
- TTS download progress if the existing progress shape cannot carry the needed state;
- warm, speak, and stop command arguments;
- worker ready, audio, done, stopped, and error events;
- sample rate, sentence sequence, request id, and transferable audio samples.

Keep the command set narrow:

- `tts_warm`
- `tts_speak`
- `tts_stop`
- the four voice-management commands from 13.2

Add renderer wrappers in `src/renderer/src/ipc/client.ts` and honest mock behavior in
`src/renderer/src/ipc/mock.ts`. Extend `src/preload/index.ts` only if the current generic event
subscription cannot carry the typed TTS event. Do not expose Node paths, child handles, or native
objects to the renderer.

Store the read-aloud choice through the existing settings key-value table. Add default,
parsing, and validation in `src/main/db/settings.ts`; no database migration is needed.

Acceptance:

- Invalid request ids, empty sentence arrays, oversized text, unknown voice states, and malformed
  settings fail at the IPC boundary.
- Mock mode can display installed, downloading, missing, playing, stopped, and failed states.
- Existing settings continue to load when the new key is absent.

### 13.4 Add the dedicated warm TTS utility

Add a second utility-process entry in `electron.vite.config.ts`. Keep it separate from the ingest
worker so narration does not share job lifecycle, model state, or crash handling with
transcription.

Extend `src/worker/sherpa-onnx-node.d.ts` with only the `OfflineTts`, VITS configuration,
generation configuration, result, and progress-callback types used here.

The TTS worker must:

- load the selected voice lazily on `warm` or the first `speak`;
- keep one `OfflineTts` instance alive;
- accept one active request at a time;
- cancel the old request before starting a new one;
- generate sentences in sequence;
- use Sherpa's progress callback to stop work when cancellation is requested;
- post each completed sentence with its sequence, sample rate, and Float32 samples;
- cap text length and worker diagnostic output;
- never write answer text or synthesized samples to logs;
- release the model and exit when the main process asks it to close.

Add a main-process `TtsManager` under `src/main/tts/`. It owns the utility handle, voice path
resolution, request ids, event forwarding, crash state, and shutdown. Mirror the existing
utility-process safety rules:

- no shell commands;
- no renderer-provided file paths;
- remove all listeners when a request ends;
- reject or stop pending work on crash;
- restart lazily on the next warm or speak request;
- never enter an automatic crash-restart loop;
- close from the app's `will-quit` path.

If read-aloud is enabled when Ask opens, call `tts_warm` without blocking the screen. If it is
disabled, do not start the worker. A warm-up failure changes only speech status.

Acceptance:

- Repeated answers reuse one loaded model.
- A newer request prevents every stale sentence from reaching playback.
- Worker crash, stop, voice removal, and app quit leave no orphan process.
- Main and renderer remain usable after a native TTS crash.

### 13.5 Add a small renderer speech controller

Keep audio scheduling outside React components in a focused module such as
`src/renderer/src/lib/ask-speech.ts`. React should observe its state and call its methods, not
own raw `AudioBufferSourceNode` objects.

The controller owns:

- one `AudioContext` using the operating system's default output;
- current request id and playback state;
- scheduled sentence sources;
- latest-request-wins filtering;
- resume, play, stop, and cleanup;
- conversion from transferred Float32 samples to `AudioBuffer`;
- sentence scheduling without overlapping two narrations.

Resume or create the `AudioContext` during a user gesture. For auto-read, prepare it from the
same Send gesture when read-aloud is enabled so browser autoplay policy does not surprise the
user after the asynchronous Ask request returns.

Add a pure, unit-tested speech-text helper. It receives `AskMessage.text` and returns bounded
sentences. It must:

- remove fenced code blocks;
- skip Markdown table rows;
- replace Markdown links with their labels;
- remove raw URLs;
- remove remaining Markdown markers without joining unrelated words;
- keep headings as speakable text;
- split sentences with `Intl.Segmenter` when available and a tested fallback otherwise;
- drop empty chunks and enforce per-sentence and total limits.

Do not speak citations, source excerpts, timestamps, follow-up suggestions, or UI labels. They
are not part of `AskMessage.text` and must stay out of the speech helper.

Acceptance:

- Audio plays in sentence order with no stale request mixed in.
- Stop cancels scheduled audio and requests worker cancellation.
- Controller cleanup closes or suspends its audio state and removes event subscriptions.
- Text cleaning never turns a code block or URL into spoken noise.

### 13.6 Integrate read-aloud with Ask

In `src/renderer/src/ui/Ask.tsx`:

- load voice status and the read-aloud setting without blocking thread rendering;
- prepare audio on Send when auto-read is enabled and the voice is installed;
- after `askSend()` resolves, find the newly returned assistant message and narrate its
  `message.text` once;
- add Read or Replay beside the existing Sources and Copy actions;
- replace Read with Stop only for the active message;
- if the voice is missing, route the action to Settings rather than starting a hidden download;
- show a small, non-blocking `Speech unavailable` state after a TTS error;
- never modify, hide, or delay the assistant text because speech failed.

The Ask screen owns the feature-level stop rules. Stop narration when:

- another question is sent;
- a new thread is created;
- a different thread is selected;
- the user opens a citation or starts recording media;
- Ask unmounts or navigation leaves the screen;
- the read-aloud setting changes to disabled.

Keep `ask_cancel` and `tts_stop` separate. Before the answer exists, the composer Stop button
cancels model generation. After the answer exists, the message action stops narration.

Acceptance:

- An enabled voice reads each new completed answer once.
- Historical assistant messages can be replayed manually.
- User messages and progress text are never spoken.
- Switching context cannot pull old speech into a new thread.
- Ask remains fully functional with no voice, no audio device, or a crashed worker.

### 13.7 Add onboarding and Settings controls

Add one optional Speech step to `src/renderer/src/ui/FirstRun.tsx` after the required model
step. Do not include TTS in the existing `setupReady` condition.

The step shows:

- what read-aloud does;
- the exact download size;
- that speech is local after download;
- `Download and enable` and `Not now` actions;
- download progress and a clear failure state.

The user may continue onboarding while the download runs. Enable read-aloud only after a valid
installation completes. A skipped, cancelled, offline, or failed download cannot block Finish.

Add a focused Speech card to `src/renderer/src/ui/Settings.tsx` near the AI settings. It shows:

- fixed voice name and installed size;
- Missing, Downloading, Installed, or Error status;
- Download, Cancel, Retry, or Remove as appropriate;
- Test voice and Stop actions after installation;
- `Read Ask answers aloud`, disabled until the voice is installed.

Downloading from Settings does not enable read-aloud automatically. Removing the voice stops
speech and disables the setting. Reuse `ActivityProvider` and `QueueShelf` for global progress
rather than inventing a second download system.

Acceptance:

- A new user can skip speech and finish setup offline.
- An existing user can install and enable speech entirely from Settings.
- Leaving onboarding or Settings does not lose active download progress.
- UI state matches the installed files after a restart or interrupted install.

### 13.8 Package, document, and verify both platforms

No voice files belong in `extraResources`. The packaged app contains the TTS worker code,
existing Sherpa native packages, extractor dependencies, voice spec, and notices only.

Verify that `electron-builder.yml` and package allowlists retain the TTS worker entry and the
needed Sherpa native libraries for Linux x64 and macOS arm64. Do not add Windows, Intel Mac,
Python, Piper binaries, CUDA, or ROCm packages.

Static verification is complete: `out/**` retains the new `tts-worker.cjs` entry, while the
platform-specific `asarUnpack` rules already retain Sherpa's Linux x64 and Darwin arm64 native
packages. Release-shaped artifacts still need the manual host checks below.

Update `THIRD-PARTY.md` with:

- Sherpa runtime use for TTS;
- the selected voice's model license and attribution;
- training-data provenance;
- pinned download URL and hash;
- extractor dependency notices.

Keep the selected voice's license or notice in its installed directory when upstream provides
one. The app-level notice must exist even before the optional download.

Verification commands remain non-build:

```text
pnpm typecheck
pnpm test
```

Do not start the app or run a build as routine verification. Native and packaged checks are
explicit, manual gates on the correct host.

## Test plan

### Unit tests

- Settings default, persistence, invalid value handling, and automatic disable on removal.
- Speech text cleanup for prose, headings, links, URLs, fenced code, inline code, tables,
  abbreviations, empty text, and length limits.
- Voice status for missing, partial, staging, installed, corrupt, and wrong-version layouts.
- Archive rejection for absolute paths, traversal, links, devices, unexpected roots, missing
  required files, wrong size, and wrong checksum.
- Atomic install, cancellation, resumable partial download, retry, and scoped removal.
- Worker protocol framing, sentence order, cancellation, stale request rejection, crash, and
  lazy restart with a fake utility process.
- Renderer controller scheduling, stop, replay, latest-request-wins, and cleanup with a fake
  audio context.
- IPC validation and mock parity.

### Native smoke tests

Add an opt-in native TTS smoke similar to the existing native-addon checks. It loads the installed
test voice through the exact `sherpa-onnx-node` path and synthesizes a short phrase. Record platform,
architecture, sample count, sample rate, load time, synthesis time, and RTF. Do not check an audio
file into Git.

Run the smoke on:

- Linux x64 from a fresh dependency install;
- macOS arm64 from a fresh dependency install;
- the unpacked or packaged application on both hosts before release.

### Manual checks

1. Skip Speech during first-run and finish setup offline.
2. Download from onboarding, leave the step, and confirm progress continues.
3. Download, cancel, resume, fail checksum, retry, and restart the app during each state.
4. Enable auto-read and submit a short Ask question.
5. Replay a historical answer and stop it halfway.
6. Submit a new question while speech is playing.
7. Switch threads, leave Ask, open a citation, and start recording media during speech.
8. Remove the voice while idle and while speaking.
9. Disconnect the network after installation and confirm synthesis remains local.
10. Run narration while transcription and diarization are active and record contention.
11. Change the operating system's default output device and confirm new playback follows it.
12. Force a TTS worker crash and confirm the text response and rest of the app remain usable.

## Measurements

Capture the exact Sherpa path, not the earlier Piper benchmark:

| Measurement | Evidence |
|---|---|
| Voice setup | archive URL, bytes, SHA-256, install time, extracted bytes |
| Cold start | utility start, model load, first sentence, peak RSS |
| Warm response | sentence synthesis time, audio duration, first playback time |
| Throughput | total synthesis time and RTF for short and long answers |
| Cancellation | stop-to-silence time during synthesis and playback |
| Contention | latency and RTF while transcription or diarization runs |
| Reliability | repeated answers, worker crash, restart, app restart, offline result |

The user-facing target is fast first playback, not a particular synthetic benchmark number.
Record medians and the first run separately.

## Exit criteria

- [ ] Three English voices are pinned and measured through Sherpa on Linux; macOS measurements
      remain a release check.
- [x] Voice setup is optional and downloads no bytes until the user chooses it.
- [x] Download, verification, safe extraction, atomic installation, cancellation, retry, and
      removal work without touching other models.
- [x] A warm utility process reuses one Sherpa `OfflineTts` instance.
- [x] Ask reads a completed assistant answer once when read-aloud is enabled.
- [x] Read, Replay, and Stop work on assistant messages.
- [x] Code, tables, URLs, citations, sources, and UI labels are not spoken.
- [x] New work, navigation, media playback, disabling, removal, and app quit stop speech.
- [x] TTS failure cannot fail or delay the text answer.
- [x] Onboarding remains finishable when speech is skipped, offline, cancelled, or failed.
- [x] Settings accurately reports voice state and nested disk usage after restart.
- [x] Settings can play and stop a fixed voice preview without enabling automatic narration.
- [ ] Native smoke passes on both release platforms and inside release-shaped artifacts.
- [x] `pnpm typecheck` and `pnpm test` pass.
- [x] `THIRD-PARTY.md` records runtime, model, dataset, download, hash, and extractor notices.

## Deferred work

- Provider text streaming and speech before the complete grounded answer exists.
- More voices, additional languages, or a remote voice catalog.
- Speed, pitch, volume, or output-device controls.
- Word-level highlighting or phoneme timing.
- Audio caching, saved narration, or export.
- Windows, Intel Mac, mobile, or remote TTS providers.
- Speaking citations, source excerpts, tables, or code.
- Voice cloning or custom voice training.

## Upstream references

- Sherpa Piper-compatible VITS models:
  `https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/vits.html`
- Sherpa Node package and examples:
  `https://www.npmjs.com/package/sherpa-onnx-node`
- LJSpeech candidate model card:
  `https://huggingface.co/rhasspy/piper-voices/blob/main/en/en_US/ljspeech/medium/MODEL_CARD`
- Norman candidate model card:
  `https://huggingface.co/rhasspy/piper-voices/blob/main/en/en_US/norman/medium/MODEL_CARD`
