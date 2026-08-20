# Manual checks — phase 05, 06 & 07

`cargo check`/`clippy`/`test` and `tsc --noEmit` are clean, but none of that runs the app.
These need a live `pnpm tauri dev` (or a built app) against a real recording. Checklist
mirrors the acceptance criteria in `docs/plan/05-ui.md`.

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

- [ ] Open a `done` recording added **after app launch** (i.e. its folder was added at
      runtime, not present in `tauri.conf.json`'s static scope) — video actually loads and
      plays. This is the classic Tauri v2 asset-scope trap; confirm it doesn't 403/blank.
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
- [ ] Rename does not affect the same speaker's label in a *different* recording (per-recording
      only, decision #4).

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
      the existing window (`tauri-plugin-single-instance`) and exits. Confirm only one
      `unottr` process remains and there's no `database is locked` / WAL contention in logs.
- [ ] **A multi-hour recording.** Feed a 4+ hour file through the pipeline. Confirm: memory
      stays bounded (checkpointed per-chunk, not held in memory), the segment count doesn't
      blow up the recordings list UI (virtualized/paginated), and diarization (global
      clustering over the whole recording) still finishes in a reasonable multiple of
      realtime.
- [ ] **AppImage on a clean machine.** Copy just the `.AppImage` (or the tarball fallback,
      whichever packaging succeeded — see below) to a machine with no Rust/Node toolchain
      and no system ffmpeg, and confirm it runs and transcribes end to end.
- [ ] **No-Vulkan fallback on a clean machine.** Run the packaged app on a machine with no
      Vulkan driver installed (or hide the loader per DESIGN.md's *Vulkan packaging*
      section) and confirm it falls back to CPU rather than crashing or hanging.
- [ ] **No-tray degradation on a clean machine.** Run the packaged app on a desktop
      environment without `libayatana-appindicator` and confirm closing the window quits
      the app gracefully instead of erroring (phase 06 behaviour, re-verify under packaging).
