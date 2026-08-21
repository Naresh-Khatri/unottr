# Manual checks — phases 05, 06, 07 & 09

`pnpm typecheck` and `pnpm test` are clean, but none of that runs the app. These need a
live `pnpm dev` (or a packaged AppImage) against a real recording. Checklist mirrors the
acceptance criteria in `docs/plan/05-ui.md`, re-pointed at the Electron app by phase 08.

## Ingest / watch folders

- [ ] Add a watch folder via the Folders panel (Recordings list -> Folders). The path shows
      up in the list immediately.
- [ ] Drop a new media file into that folder. It appears in the recordings list within a
      couple of poll ticks (default 2s) with no manual refresh — confirms `recording_discovered`.
- [ ] The row progresses through discovered -> probing -> extracting -> transcribing ->
      diarizing -> merging -> done live, with the progress bar moving, and with **no polling**
      (network tab / no repeated `list_recordings` calls needed to see it move).
- [ ] Click **Backfill** on a folder that already has existing files unrelated to the watcher
      startup scan; confirm they get queued and processed.
- [ ] Remove a watch folder; its existing recordings stay in the list (removal only stops
      future watching, per decision — doesn't delete history).

## Time remaining (eta)

- [ ] The first job on a fresh database shows an estimate next to the status chip as soon as
      probing finishes — the prior alone is enough, before anything has been measured.
- [ ] It counts down monotonically and does **not** jump back up when transcription hands
      over to diarization.
- [ ] The number lands within roughly 20% of the real wall time by mid-transcription, and
      within a few percent on the *second* recording of the same length and model (the rate is
      learned by then).
- [ ] Force the CPU fallback (Settings -> device, or a gpu-oom retry). The estimate grows to
      match the much slower run instead of holding the gpu figure.
- [ ] Retry a checkpointed job: the estimate opens at the resume point rather than quoting the
      whole file, and that run does not poison the next estimate (a same-length fresh job still
      quotes sensibly).
- [ ] Tray menu status line shows the same figure as the list row, and stops at "Idle" when
      the queue drains.
- [ ] A recording with no duration (probe failed to report one) shows a progress bar and no
      estimate — never `NaN` or `~0m left`.

## Failure / retry

- [ ] Force a job to fail (e.g. point a watch folder at a corrupt/truncated file). The row
      shows the error inline, no modal/notification interrupts anything else in the app.
- [ ] Click the row's trailing **retry** button. The row goes back to `discovered`/`probing`
      and completes normally; clicking it must not open the transcript.
- [ ] Retry resumes from the last checkpoint rather than reprocessing finished chunks (check
      logs for chunk index on resume vs. a fresh run).
- [ ] Same button on a `done` row re-transcribes from chunk 0 and replaces the old transcript;
      speaker renames survive. It is hidden mid-job and disabled when the source is missing.

## Video playback

- [ ] Open a `done` recording added **after app launch** — video actually loads and plays
      over `unottr://media/<id>`. Also seek backwards in a long file: the protocol handler
      must answer the range request with a 206, so a blank frame or a player that refuses
      to scrub means the range path is wrong, not the codec.
- [ ] Open a recording whose container the old WebKitGTK build could not play (H.264/AAC
      `.mp4` on a machine with no GStreamer plugins installed). Chromium ships its own
      decoders, so this is the check that the reason for the migration actually holds.
- [ ] Click a segment in the transcript -> video seeks to that segment's start accurately
      (within ~1 frame/scrub granularity).
- [ ] Play the video -> the active segment highlight tracks playback and the list auto-scrolls
      to keep it in view.
- [ ] Scroll the transcript list manually while the video is playing -> auto-scroll suspends
      (stays where you left it) and resumes following playback ~1.5s after you stop scrolling.
- [ ] Open a recording with `available = 0` (source file moved/deleted) -> no player, "recording
      unavailable" notice shown instead, and the transcript text/search below it still works.

## Speaker rename

- [ ] Rename a speaker inline (click the label, edit, blur/Enter). All of that speaker's
      segments in the transcript update immediately.
- [ ] Restart the app (or just re-open the recording) -> the renamed speaker name persists.
- [ ] A second rename box offers the name as a completion (datalist), so the same voice does
      not end up with two spellings.

## Global speaker identity

- [ ] Name a speaker in recording A, then let a *new* recording with the same person finish
      diarizing -> that speaker comes out already named, with nobody typing.
- [ ] The auto-named speaker is the right one: skim a few of their segments before trusting
      it. A wrong match here is the failure mode the 0.45 cut exists to prevent.
- [ ] Naming a speaker in an *older* recording does not retro-name anyone else (forward only,
      by decision).
- [ ] Two different people in one recording never collapse onto the same name, even when
      their voices are close.
- [ ] Settings -> People lists everyone with a recording count. Rename there -> the new name
      shows in every recording they appear in.
- [ ] Forget a person -> their speakers go back to `Speaker N` everywhere, and the next
      recording no longer auto-names them.
- [ ] Re-run a recording (Retry) after naming its speakers -> the names survive re-diarization
      and no speaker gets re-matched to someone else.
- [ ] Export a transcript with a globally-named speaker -> the person's name appears, not the
      `Speaker N` label.

## Find-in-transcript

- [ ] Type a phrase that appears multiple times -> all matches get a highlight ring, match
      counter shows `n/total`.
- [ ] Next/prev buttons (and Enter / Shift+Enter in the find box) jump between matches and
      scroll each into view, including matches far outside the currently-rendered virtualized
      window (i.e. not just the ones already on screen).

## Search screen

- [ ] Search a phrase known to exist in a real transcript from the corpus -> a hit appears
      with the correct recording, timestamp, and `<b>`-highlighted snippet.
- [ ] Click a hit -> opens the transcript view seeked to that hit's timestamp (video seeks
      there too, once playing).
- [ ] Search over an `available = 0` recording's transcript still returns hits (search must
      not silently exclude unavailable recordings).

## Virtualization / scale

- [ ] A recordings list with several hundred+ rows scrolls smoothly (no visible jank), and
      row heights stay correct for rows that have a progress bar or an inline error (i.e. taller
      rows don't get clipped or overlap neighbours).
- [ ] A transcript with several thousand segments scrolls smoothly; jumping via find-in-transcript
      or clicking a far-away segment lands in the right place without a visible flash of wrong
      content.

## Shutdown

- [ ] Quit the app while a job is mid-chunk. It doesn't exit instantly — it waits for the
      current chunk to checkpoint before the process actually closes (check logs for "shutting
      down ingest service" followed by the worker's checkpoint log, in that order).
- [ ] Relaunch -> the in-progress recording resumes from that checkpoint instead of restarting.

## Resource meters (sidebar footer)

- [ ] With the app idle, CPU and GPU sit low and both bars move on their own every ~1.5s.
- [ ] Start a transcription: the meters climb and the GPU bar tracks whatever `radeontop` /
      `nvidia-smi` reports (within a poll of each other).
- [ ] Expand the caret: per-core bars, load, RAM, CPU temp/power, GPU name/VRAM/temp/power,
      the resolved compute device and the queue counts all appear; the queue line matches
      the library.
- [ ] CPU **Temp** and **Power** match `sensors` and `turbostat`/`powerstat` within a few
      units, and climb under a transcription. Where `energy_uj` is root-only (common outside
      Arch) or no die sensor is exposed, the row is simply absent — no `undefined`, and
      everything else still renders.
- [ ] On a machine with no GPU (or with the Vulkan ICD hidden), the GPU row reads `—` and
      the expanded panel says `none detected` — no crash, CPU keeps updating.
- [ ] Minimize to tray, wait a minute, restore: numbers resume immediately and no polling
      happened while hidden (check the main-process log / CPU of the app while minimized).

## Settings persistence (phase 06)

- [ ] Change model tier / language / device / diarize threshold in Settings, then drop a new
      file in a watch folder. The next job picks up the new value with **no app restart**
      (confirm in logs — no restart happened, and the pipeline config reflects the change).
- [ ] Set an ffmpeg/ffprobe path override or a cache location override in Settings, then
      restart the app. Only *after* restart does the new path/location actually take effect
      (this pair is read once at startup, unlike the pipeline-config settings above).
- [ ] Force device to `cpu` -> confirm in logs the run actually used CPU, not GPU.
- [ ] Restart the app after changing any setting -> `get_settings` reflects the persisted
      value, not a default.

## Model download UX

- [ ] From Settings -> Model, download a tier that isn't present. Progress bar advances via
      `model_download_progress` events (no polling needed), and the tier shows "downloaded"
      once done.
- [ ] Cancel a download mid-progress -> it stops advancing and the tier does not get marked
      downloaded. Re-downloading afterward resumes rather than starting over (`.part` file).
- [ ] Disk usage numbers in the Model card update after a download completes and after
      Clear Cache is used.

## Tray + window lifecycle

- [ ] On a desktop environment with a tray (e.g. a DE with `libayatana-appindicator`
      support): closing the main window hides it instead of quitting; the watcher keeps
      running (drop a file in a watched folder while the window is hidden -> it still gets
      processed). Tray menu shows Show / status line / Quit.
- [ ] Tray status line reads `Idle` with nothing in flight and `Transcribing 1 of N` while a
      job is running and others are queued.
- [ ] First time the window is closed to tray, a one-time hint appears (tooltip, not a
      blocking dialog). Closing again does not repeat the hint.
- [ ] On a DE with no tray support (or by simulating `tray::build` failing): closing the
      window quits the app outright, with a graceful shutdown (worker finishes its current
      chunk — see the Shutdown section above), not an abrupt kill.
- [ ] Toggle "Keep running in tray when closed" off in Settings -> closing the window quits
      instead of hiding, even though a tray exists.
- [ ] Quit from the tray menu stops the worker cleanly at a chunk boundary (same log
      ordering as the Shutdown section above).

## Autostart

- [ ] Enable autostart in Settings -> a `.desktop` file appears under
      `~/.config/autostart` (or platform equivalent). Disable it -> the file is removed
      cleanly, no leftover entry.
- [ ] Autostart is off by default on a fresh data dir.

## First-run flow

- [ ] Launch with `UNOTTR_DATA_DIR=$(mktemp -d)` (a genuinely empty data dir) -> the
      first-run wizard appears instead of the normal library view.
- [ ] Step through: welcome -> pick a folder (folder actually gets added as a watch
      folder) -> download a model (Next is blocked until the model is actually present,
      progress bar advances) -> backfill offer shows a real count/duration for existing
      files in that folder and requires an explicit Confirm click before anything is queued
      -> MKV-over-MP4 tip -> Finish.
- [ ] After Finish, the wizard never reappears on subsequent launches (`first_run_complete`
      persisted); the picked model tier is the active `model_tier` setting.
- [ ] Backfill offer step with zero existing files in the picked folder skips gracefully
      (no confirm button, no error) and Next still works.

## Export

- [ ] Export a transcript with segments and multiple named speakers to each of
      `.txt`/`.json`/`.srt`/`.vtt` via the native save dialog. No file is written unless the
      dialog is completed (cancelling the dialog writes nothing).
- [ ] Open the `.srt` and `.vtt` files in a real video player (e.g. mpv/VLC) against the
      source recording -> subtitles line up with speech, speaker labels (if present in the
      text) render sanely.
- [ ] `.json` export round-trips the segment/speaker data faithfully (spot check a few
      timestamps and speaker names against the transcript view).

## AI overview (phase 09)

The only checks here that a test suite cannot do are the ones that need a real model
answering about a real meeting. Everything in this section costs API credit — the last two
groups (no key, failure) do not.

- [ ] **No connection configured.** With `ai_connections` empty the app behaves exactly as
      it does today, everywhere: the Overview tab opens, says no model is connected, and
      links to Settings. No network call is made at any point — confirm with the app running
      behind a proxy log or `ss -tp` while opening recordings, browsing, searching and
      exporting.
- [ ] **The consent dialog shows the real payload.** Before the first generate, the excerpt
      shown is the actual serialized transcript (`[id] Name: text`), matching what
      `prompt.ts` builds — not a paraphrase of it. Turn on **Pseudonymize** and confirm the
      excerpt itself changes to `Speaker N`.
- [ ] **Citations land.** Generate on a real corpus recording. Click through every bullet,
      decision and task timecode and confirm each one opens the video at the moment that
      claim actually came from. One that lands on the wrong minute is the failure this whole
      feature is judged on.
- [ ] **Quoted phrases survive code-switching.** On the mixed English/Malay recordings, the
      prose is English but any quoted phrase is verbatim in the language it was spoken in —
      a translated "quote" is a fabricated one.
- [ ] **Mine vs theirs.** Mark a person as "me" in Settings -> People and give them a role.
      Regenerate; tasks split correctly into *Your actions* and *Everyone else's*, and the
      role visibly biases what gets extracted (an engineering manager's list should not read
      like an IC's).
- [ ] **Anonymous speakers.** On a recording where nobody has been named, *Your actions*
      says so and points at the naming affordance — not an empty list that looks like a bug.
- [ ] **Regenerate merges.** Check one task done, dismiss another, edit a third's text, then
      Regenerate. All three survive verbatim; everything untouched is replaced.
- [ ] **Cancel.** Press Cancel mid-generate: the row leaves `running` immediately, the tab
      returns to its Generate state, and no partial overview is written.
- [ ] **Quit mid-generate.** Kill the app while a generate is in flight, relaunch, and
      confirm no recording is left stuck in `running`.
- [ ] **A failed call is not a failed transcript.** Save a deliberately wrong API key and
      generate. The error names the cause ("Check the key"), `recordings.status` stays
      `done`, and the transcript stays readable and searchable throughout.
- [ ] **Search finds overview text.** Search a phrase that appears only in a generated
      summary -> the hit carries the *Overview* badge and clicking it opens that tab, not the
      transcript at 0:00.
- [ ] **Stale banner.** Rename a speaker (or Retry the recording) after generating -> the
      Overview tab shows the stale notice and offers Regenerate, without discarding what is
      already there.
- [ ] **Export.** `.txt` gains the overview as a header block above the transcript; `.json`
      carries `overview` and `tasks` in full; `.srt`/`.vtt` are **byte-identical** to what
      the same recording exported before the overview existed (diff them).
- [ ] **`safeStorage` on bare Linux.** On a session with no keyring (e.g. a bare WM with no
      gnome-keyring/kwallet running), saving a key fails *loudly*: the app says encryption is
      unavailable and requires an explicit "store it unencrypted anyway" before writing
      anything. Afterwards Settings says "Stored unencrypted" plainly.

## Providers (phase 10)

Everything here is about setup, so most of it costs nothing — only the two rows marked
*generates* actually spend anything.

- [ ] **Ollama, found not typed.** With `ollama serve` running, open Settings -> AI ->
      Manage. The add form arrives with Ollama already selected, the base URL filled in, and
      its installed models in the dropdown. Nothing was typed. Stop ollama and reopen: the
      form is empty and quiet, not an error.
- [ ] **The URL people actually paste.** Type each of `localhost:11434`,
      `http://localhost:11434/api`, `http://localhost:11434/v1/chat/completions` and
      `api.openai.com` into the base URL field and tab away. Each resolves to the right
      root, visibly, before you press anything.
- [ ] **LM Studio's loaded model wins.** With LM Studio serving and one model loaded, pick
      the LM Studio preset. The dropdown offers the loaded model *first*, embeddings are not
      in it at all, and any image/video model sits at the bottom. Test passes without you
      choosing anything — the alphabetically-first model is usually not a chat model, and
      picking one is what made a working server report *not working*.
- [ ] **The model is always visible.** Every path into the form — preset chip, pasted URL,
      Test — ends with a model named in the picker or an amber line saying none is picked.
      There is no state where the field is silently empty and Save is still offered as if
      the connection were finished.
- [ ] **An old row heals itself.** With a connection whose model was never set (`UPDATE
      ai_connections SET active_model = NULL`), open Manage: the amber line is replaced by a
      real model id within a moment, without pressing anything. Kill the server first and it
      stays amber rather than hanging the dialog.
- [ ] **A meeting longer than the context.** Point at an 8k local model and generate over an
      hour-long recording. It does not fail: the log shows several completions instead of
      one, the overview covers the whole meeting rather than its first ten minutes, and no
      bullet appears twice at a window boundary. Timestamps still jump to the right moment.
- [ ] **A slow model is waited for.** Generate against a local model that takes minutes to
      read its prompt (LM Studio's log shows *Prompt processing progress*). It is not
      cancelled at two minutes: the log runs to 100%, then generates, and the overview
      arrives. The panel says which part is being read and the clock keeps counting.
- [ ] **The window is learned.** Add an LM Studio connection with a model loaded at 8192 and
      open the edit form's *Advanced*: *Context* reads 8192, not the model's 131072 maximum. Type your own
      number and re-open — yours survives.
- [ ] **A long list still fits.** With eight or more connections, the dialog stops growing:
      the rows scroll on their own and *Add another*, the title and the close button stay
      put. Shrink the window until it is shorter than the edit form — the whole dialog
      scrolls rather than running off the top and bottom of the screen.
- [ ] **Test does not add connections.** On the add form, press Test three times: the list
      behind it gains exactly one row, not three. Press Cancel (or close the dialog with the
      X) without saving and that row is gone; press Save and it stays, tested.
- [ ] **Two of the same provider are distinguishable.** Add a second LM Studio connection:
      it is named *LM Studio 2*, not a second *LM Studio*. Rename it and re-save — the name
      you typed survives.
- [ ] **Which one is active.** Open Manage with two or more connections: exactly one radio
      is filled, its row is outlined, and it is badged *active*. Click another row anywhere
      but its buttons — the selection moves, the settings card behind it follows. Edit and
      the bin do not change the selection.
- [ ] **Four rungs, in order.** Press Test against a working local server: all four tick,
      in order, and the last one names the strategy it settled on. Then point the same
      connection at a port with nothing on it — *reachable* fails and the rest stay grey
      rather than silently green.
- [ ] **A model that answers but cannot shape** (*generates*). Connect a small local model
      (a 1-3B instruct without json-schema support). Test: the first three rungs pass and
      *structured* either falls back to a lower rung and passes, or fails clearly. Whichever
      it says, Generate must agree with it — a green Test followed by a failed Generate is
      the exact bug this whole checklist exists to catch.
- [ ] **Wrong key.** Save a deliberately wrong key on a hosted provider and Test:
      *reachable* passes, *authorized* fails, and the message names the key rather than the
      network.
- [ ] **Test survives a reopen.** Test, close the dialog, quit the app, relaunch. The status
      dot still reads *working* and the checklist is still there — it is stored, not
      recomputed from nothing.
- [ ] **Consent is per connection.** Consent to a local connection and generate. Add a
      hosted one, activate it, and generate again: the consent dialog appears a second time,
      and its wording says the transcript leaves the machine (the local one says it does
      not).
- [ ] **Two connections, one active.** Add both a local and a hosted connection. Only one is
      active; switching which one is active changes what the Settings line and the Overview
      tab say, and the next generate goes to the new one (check the overview footer names
      it: "qwen3:8b via Ollama").
- [ ] **Context too small, caught before spending** (*generates*). Set a connection's
      context to something small (say 4096) and generate on a long recording. It refuses
      up front, names the numbers, and no request is made — confirm with a proxy log — and
      the transcript is untouched.
- [ ] **Delete the active connection.** Remove it while it is active. The Overview tab falls
      back to the no-connection state rather than erroring, and the stored key goes with the
      row (check `ai_connections` is empty and no key lingers in `settings`).
- [ ] **Upgrade from a 0.4 database.** Take a database that had a Mistral key configured,
      launch this build: a single connection named Mistral exists, it is active, the key
      still works without retyping, consent and spend carried over, and the old
      `mistral_api_key_*` / `ai_model` / `ai_consented` settings rows are gone.

## Hardening / packaging (phase 07)

- [ ] **Full disk during PCM extraction.** Not automated: ffmpeg's own write fails with
      `ENOSPC`, which `extract_pcm` surfaces as `Error::Io`, same as any other write
      failure — no special-cased handling needed or added. To actually exercise it, extract
      onto a small tmpfs (`mount -t tmpfs -o size=10M tmpfs /mnt/tiny`) with a recording
      that needs more than that once decoded to 16 kHz mono PCM (~115 MB/hour) and confirm
      the job parks on a typed `Io` error, not a panic or a truncated silent success.
- [ ] **Source file deleted after extraction, mid-transcription/diarization.** Only the
      extraction stage (`probe`/`extract_pcm`) still touches the original path — covered by
      the automated `a_file_deleted_before_extraction_is_a_typed_error_not_a_panic` test in
      `ffmpeg.rs`. Once PCM exists in the cache, transcribe/diarize/merge never reopen the
      source, so deleting it mid-job should have **no effect** on that job (confirm: delete
      the source while a job is transcribing, job still completes; only playback afterward
      shows the recording as unavailable).
- [ ] **Two instances started at once.** Launch the AppImage/binary twice in a row. The
      second launch does not open a second window or a second DB connection — it focuses
      the existing window (`app.requestSingleInstanceLock`) and exits. Confirm only one
      `unottr` process remains and there's no `database is locked` / WAL contention in logs.
- [ ] **A multi-hour recording.** Feed a 4+ hour file through the pipeline. Confirm: memory
      stays bounded (checkpointed per-chunk, not held in memory), the segment count doesn't
      blow up the recordings list UI (virtualized/paginated), and diarization (global
      clustering over the whole recording) still finishes in a reasonable multiple of
      realtime.
- [ ] **AppImage on a clean machine.** Copy just the `.AppImage` to a machine with no Node
      toolchain and no system ffmpeg, and confirm it runs and transcribes end to end.
- [ ] **No-Vulkan fallback on a clean machine.** Run the packaged app on a machine with no
      Vulkan driver installed (or hide the loader per DESIGN.md's *Vulkan packaging*
      section) and confirm it falls back to CPU rather than crashing or hanging.
- [ ] **No-tray degradation on a clean machine.** Run the packaged app on a desktop
      environment without `libayatana-appindicator` and confirm closing the window quits
      the app gracefully instead of erroring (phase 06 behaviour, re-verify under packaging).
