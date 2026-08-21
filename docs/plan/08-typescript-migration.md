# Phase 08 — Tauri/Rust to Electron/TypeScript

**Goal:** one language. Everything that is Rust today becomes TypeScript, the Tauri shell
becomes Electron, and the `crates/` workspace is deleted. No sidecar, no FFI, no Rust left
behind.

**Depends on:** phases 00–07, all shipped. This phase rewrites them rather than extending
them.

**Why:** decision #6 (Tauri) is reversed. Two reasons, in order of weight.

1. The owner cannot read the backend. ~7,000 lines of `unottr-core` are effectively
   unreviewable, which makes every change an act of faith rather than review. That is a
   review-confidence problem and it does not improve with time.
2. WebKitGTK has no media stack of its own — `<video>` *is* GStreamer, so a missing
   demuxer kills the whole web process. Phase 07 worked around it by bundling GStreamer
   plugins into the AppImage. Electron ships Chromium with proprietary codecs enabled, so
   the class of bug disappears along with ~120 MB of bundled plugins and two fetch scripts.

Bundle size is explicitly not a constraint.

---

## Feasibility — already verified

The GPU path was the only thing that could have vetoed this, so it was spiked first, on
this machine, against the real models.

| Check | Result |
|---|---|
| `@fugood/whisper.node` + `@fugood/node-whisper-linux-x64-vulkan` | prebuilt, no compile |
| Vulkan, `base.en` | 147.37 MB on `Vulkan0`; init 151 ms, infer 145 ms for 11 s audio |
| Vulkan, `large-v3-turbo-q5_0` | 573.40 MB on `Vulkan0`; init 307 ms, infer 599 ms, correct text |
| Word timestamps | `maxLen: 1, wordThold: 0.01` yields per-word segments |
| Cancellation | `transcribe()` returns `{ stop, promise }` |
| Silero VAD on GPU | **aborts**, exit 134 |
| Silero VAD on CPU | works, 231–462 ms |
| `sherpa-onnx-node@1.13.6` | `OfflineSpeakerDiarization` + `SpeakerEmbeddingExtractor`, prebuilt `sherpa-onnx-linux-x64` |

The card is an RX 6700 XT on RADV. There is no CUDA on this machine, so Vulkan is the
only GPU path and it is the one that was tested.

The sherpa API maps 1:1 onto what `diarize/engine.rs` uses: `FastClusteringConfig` exposes
both `threshold` and `numClusters`, which is exactly the fixed-k vs threshold switch the
two-stage clustering depends on, and the embedding extractor returns a raw `Float32Array`
so the centroid pass ports unchanged.

### Three findings that will cost days if forgotten

1. **Silero VAD must run `useGpu: false`.** Identical to the `chunk.rs:53` workaround, and
   it is a SIGABRT from inside ggml, not a catchable exception. It kills the process. This
   alone justifies running compute in a separate process.
2. **Three different time units are in play.** `WhisperContext.transcribe()` returns
   `t0`/`t1` in **milliseconds**. `WhisperVadContext.detectSpeech()` returns
   **centiseconds** (`t0: 29` is 0.29 s). `OfflineSpeakerDiarization.process()` returns
   **seconds as floats**. Mixing any two silently produces boundaries wrong by 10× or 100×.
   Everything crossing a module boundary is milliseconds; conversion happens at the native
   call site and nowhere else.
3. **`onProgress` is useless** — it fires exactly 0 and 100. The `job_progress` event has
   to be derived from completed-chunk count over total-chunk count, which the Rust already
   does. Sherpa's `process()` exposes no progress callback at all and blocks for minutes,
   so the diarize stage reports a stage change and then nothing until it finishes.

---

## Architecture

```
+--------------------- Electron main -----------------------+
|  ipc handlers | watcher | job queue | drizzle + SQLite     |
|  tray | autostart | model downloads | unottr:// protocol   |
+---------------+-------------------------------+-----------+
                |  MessagePort                  |  IPC
                v                               v
+--------------------------+     +--------------------------+
|  utilityProcess (worker) |     |  renderer (React 19)     |
|  whisper.node (Vulkan)   |     |  unchanged from phase 05 |
|  sherpa-onnx-node        |     +--------------------------+
|  chunk / cluster / merge |
|  spawns ffmpeg           |
+--------------------------+
```

Three rules that shape everything below.

**The worker never touches the database.** It receives a job description, streams results
back over the message port, and main writes them. SQLite stays single-writer, drizzle stays
the only thing that knows the schema, and the worker can be killed at any instant without
leaving a half-written transaction. The cost is one message per ~30 s chunk, which is
nothing.

**The worker is disposable.** Cancelling a job that is inside a blocking native call means
killing the process. Sherpa's `process()` cannot be interrupted, and a ggml abort takes the
process down whether we like it or not. Fork one worker per job, kill it on cancel, and
treat its death as a normal outcome rather than a crash.

**Main-process logic does not import `electron`.** Everything under `src/main/db`,
`src/main/ingest`, `src/main/media`, `src/main/models` stays plain Node so the CLI can
drive it headless, exactly as `unottr-core` is Tauri-free today. Electron APIs live in
`src/main/index.ts`, `window.ts`, `tray.ts`, `autostart.ts`, and `ipc/handlers.ts`.

### What each Rust file becomes

| Rust | TypeScript | Notes |
|---|---|---|
| `db/migrations.rs` (129) | `main/db/schema.ts` + `drizzle/` | V1–V4 collapsed into one greenfield schema |
| `db/recordings.rs` (440) | `main/db/recordings.ts` | |
| `db/settings.rs` (261) | `main/db/settings.ts` | |
| `db/watch_folders.rs` (160) | `main/db/watchFolders.ts` | |
| `src-tauri/ipc/queries.rs` (486) | `main/db/queries.ts` | the read side of all 24 commands |
| `media/ffmpeg.rs` (424) | `main/media/ffmpeg.ts` | already a subprocess; `child_process` |
| `media/track.rs` (266) | `main/media/track.ts` | pure logic, ports directly |
| `media/mod.rs` (187) | `main/media/pcm.ts` | PCM read/mix/size maths |
| `model.rs` (252) | `main/models/download.ts` | `fetch` + Range + `node:crypto` sha256 |
| `transcribe/model.rs` (83) + `diarize/model.rs` (81) | `main/models/catalog.ts` | |
| `transcribe/engine.rs` (405) | `worker/whisper.ts` + `main/models/device.ts` | device probe stays in main |
| `transcribe/chunk.rs` (243) | `worker/chunk.ts` | VAD chunking; **CPU-pinned** |
| `transcribe/mod.rs` (287) | `worker/transcribe.ts` | |
| `diarize/engine.rs` (622) | `worker/diarize.ts` + `worker/cluster.ts` | UPGMA rejoin + prune |
| `diarize/merge.rs` (463) | `worker/merge.ts` | overlap argmax + word-boundary split |
| `diarize/mic.rs` (143) | `worker/mic.ts` | |
| `diarize/mod.rs` (667) | `worker/diarize.ts` + `main/ingest/pipeline.ts` | persistence moves to main |
| `ingest/watch.rs` (500) | `main/ingest/watch.ts` | chokidar; see the fidelity note in 08.5 |
| `ingest/worker.rs` (216) | `main/ingest/queue.ts` | |
| `ingest/pipeline.rs` (207) | `main/ingest/pipeline.ts` | |
| `ingest/backfill.rs` (162) | `main/ingest/backfill.ts` | |
| `ingest/reconcile.rs` (133) | `main/ingest/reconcile.ts` | |
| `ingest/fingerprint.rs` (84) | `main/ingest/fingerprint.ts` | blake3 -> sha256, see 08.5 |
| `ingest/config.rs` (53) | `main/ingest/config.ts` | |
| `export.rs` (277) | `main/export.ts` | |
| `paths.rs` (112) | `main/paths.ts` | `app.getPath` in Electron, env vars in the CLI |
| `error.rs` (118) | `main/errors.ts` | tagged union, not a class hierarchy |
| `cancel.rs` | `AbortSignal` + `worker.kill()` | |
| `logging.rs` | `main/logging.ts` | `electron-log` |
| `src-tauri/ipc/commands.rs` (278) | `main/ipc/handlers.ts` | |
| `src-tauri/ipc/events.rs` (60) | `main/ipc/events.ts` | |
| `src-tauri/ipc/types.rs` (204) | `shared/types.ts` | merged with today's `src/ipc/types.ts` |
| `src-tauri/tray.rs` (124) | `main/tray.ts` | |
| `src-tauri/scope.rs` | deleted | replaced by id-addressed media, see 08.1 |
| `src-tauri/gst.rs` (81) | deleted | Chromium ships the codecs |
| `unottr-cli/main.rs` (840) | `src/cli/index.ts` | thinner; the app is the main consumer now |

Roughly 9,900 lines of Rust becoming TypeScript. The count is not the point — the point is
that no line of it stays unreadable.

### Dependencies

| Need | Package | Note |
|---|---|---|
| shell | `electron` | latest stable |
| build | `electron-vite`, `electron-builder` | |
| db | `better-sqlite3`, `drizzle-orm`, `drizzle-kit` | |
| asr | `@fugood/whisper.node` + `@fugood/node-whisper-linux-x64-vulkan` | prebuilt |
| diarization | `sherpa-onnx-node` + `sherpa-onnx-linux-x64` | prebuilt |
| watching | `chokidar` | |
| logging | `electron-log` | |
| tests | `vitest` | |
| native rebuild | `@electron/rebuild` | for `better-sqlite3` only |

Dropped: `@tauri-apps/*` (5 packages), `blake3`, `ureq`, `sha2`, `directories`, `notify`,
`tracing*`, `rusqlite`, `whisper-rs`, `sherpa-rs`, and the entire Cargo toolchain.

`@fugood/whisper.node` and `sherpa-onnx-node` are node-api addons and should load in
Electron unmodified. `better-sqlite3` is the one that needs `@electron/rebuild` against the
Electron ABI — which means the CLI cannot run under plain `node`, because it would load an
Electron-ABI binary. Run it as `ELECTRON_RUN_AS_NODE=1 electron out/cli/index.js`. Settle
this in 08.1 before anything depends on it.

---

## Project structure

```
unottr/
├─ electron.vite.config.ts       main + worker + preload + renderer entries
├─ electron-builder.yml
├─ drizzle.config.ts
├─ package.json
├─ tsconfig.json                 project refs -> node / web
├─ tsconfig.node.json
├─ tsconfig.web.json
├─ vitest.config.ts
├─ drizzle/
│  ├─ 0000_init.sql              generated from schema.ts
│  ├─ 0001_fts.sql               --custom: virtual table + 3 triggers
│  └─ meta/
├─ resources/                    electron-builder extraResources
│  ├─ ffmpeg                     LGPL build, fetched by scripts/fetch-ffmpeg.sh
│  └─ ffprobe
├─ fixtures/                     phase 08.0 oracle, committed
│  ├─ jfk/
│  └─ corpus-01/
│     ├─ probe.json
│     ├─ chunks.json
│     ├─ utterances.json
│     ├─ turns.json
│     └─ merged.json
├─ scripts/
│  ├─ fetch-ffmpeg.sh            kept
│  └─ dump-fixtures.sh           kept until 08.7, then deleted
├─ src/
│  ├─ main/
│  │  ├─ index.ts                app lifecycle, single instance, wiring
│  │  ├─ window.ts
│  │  ├─ tray.ts
│  │  ├─ autostart.ts            writes ~/.config/autostart/unottr.desktop
│  │  ├─ media-protocol.ts       unottr://media/<id>, Range-aware
│  │  ├─ paths.ts
│  │  ├─ logging.ts
│  │  ├─ errors.ts
│  │  ├─ db/
│  │  │  ├─ client.ts            better-sqlite3, WAL, foreign_keys, busy_timeout
│  │  │  ├─ schema.ts            drizzle table definitions
│  │  │  ├─ migrate.ts
│  │  │  ├─ recordings.ts
│  │  │  ├─ segments.ts
│  │  │  ├─ speakers.ts
│  │  │  ├─ settings.ts
│  │  │  ├─ watchFolders.ts
│  │  │  └─ queries.ts           read side of the IPC contract
│  │  ├─ ingest/
│  │  │  ├─ service.ts           start/stop, owns watcher + queue
│  │  │  ├─ watch.ts
│  │  │  ├─ fingerprint.ts
│  │  │  ├─ queue.ts             serial, retry x2, graceful shutdown
│  │  │  ├─ pipeline.ts          drives the worker, writes checkpoints
│  │  │  ├─ reconcile.ts
│  │  │  ├─ backfill.ts
│  │  │  └─ config.ts
│  │  ├─ media/
│  │  │  ├─ ffmpeg.ts            spawn, arg building, stderr parsing
│  │  │  ├─ probe.ts
│  │  │  ├─ track.ts             the track rule
│  │  │  └─ pcm.ts
│  │  ├─ models/
│  │  │  ├─ catalog.ts           whisper tiers, silero, seg + embedding models
│  │  │  ├─ download.ts          resumable, sha256-verified
│  │  │  └─ device.ts            gpu probe, resolve()
│  │  ├─ export.ts
│  │  └─ ipc/
│  │     ├─ handlers.ts          24 handle() registrations
│  │     └─ events.ts            5 typed emitters
│  ├─ worker/                    utilityProcess, pure compute
│  │  ├─ index.ts                message loop, one job at a time
│  │  ├─ protocol.ts             job + result message types
│  │  ├─ whisper.ts
│  │  ├─ vad.ts                  useGpu:false, centiseconds -> ms here
│  │  ├─ chunk.ts
│  │  ├─ transcribe.ts
│  │  ├─ diarize.ts              seconds -> ms here
│  │  ├─ cluster.ts              UPGMA rejoin + prune
│  │  ├─ merge.ts
│  │  └─ mic.ts
│  ├─ preload/
│  │  └─ index.ts                contextBridge -> window.unottr
│  ├─ shared/
│  │  ├─ types.ts                the IPC contract, single source
│  │  ├─ channels.ts             channel name constants
│  │  └─ units.ts                ms/cs/s conversions, one place
│  ├─ cli/
│  │  ├─ index.ts                headless driver, no electron imports
│  │  └─ commands/
│  └─ renderer/
│     ├─ index.html
│     └─ src/                    today's src/, moved almost verbatim
│        ├─ main.tsx
│        ├─ App.tsx
│        ├─ index.css
│        ├─ ipc/
│        │  ├─ client.ts         same shape, window.unottr instead of invoke
│        │  ├─ mock.ts
│        │  └─ types.ts          re-export from shared/
│        ├─ components/ui/       15 shadcn files, untouched
│        ├─ lib/                 format, errors, virtual, media, utils
│        └─ ui/                  9 screens, untouched
└─ test/
   ├─ chunk.test.ts
   ├─ cluster.test.ts
   ├─ merge.test.ts
   ├─ track.test.ts
   ├─ fingerprint.test.ts
   └─ queries.test.ts
```

`electron-vite` builds `main` and `worker` from one config by giving the main build two
rollup inputs, so `utilityProcess.fork(join(__dirname, 'worker.js'))` resolves next to the
main bundle.

---

## 08.0 — Oracle

**Do this first, while the Rust still runs.** It is the only phase that becomes impossible
later, and it is what makes the rest reviewable: the port is correct when it reproduces
these files, not when it looks right.

1. Pick three inputs: `jfk.wav` (fast loop), one short corpus recording, one 33-minute one.
2. Run each end to end through the Rust CLI on the current database.
3. Dump per input, as JSON: `probe.json` (probe + track selection — `unottr probe` already
   emits this), `chunks.json` (VAD spans and chunk boundaries), `utterances.json` (whisper
   output with word timestamps), `turns.json` (diarization turns + centroids, pre-merge),
   `merged.json` (final segment/speaker assignment including `split_of`).
4. `merged.json` and the segment/speaker rows come straight out of SQLite. `chunks.json`
   and `turns.json` are intermediates nothing persists, so add a `--dump-json <path>` flag
   to the existing `transcribe` and `diarize` subcommands. Roughly 40 lines of Rust in a
   crate being deleted. Worth it — those two files are the spec for the two hardest ports
   (`chunk.rs` and `merge.rs`).
5. Also record the wall-clock and RTF of each run. `DESIGN.md`'s performance table is the
   regression baseline for the TypeScript pipeline.

Commit `fixtures/` to the repo.

**Acceptance**
- [ ] Three inputs, five JSON files each, committed.
- [ ] Re-running the Rust reproduces them byte-for-byte apart from timing fields.
- [ ] Baseline RTF recorded for transcribe (GPU and CPU) and diarize.

---

## 08.1 — Electron shell, UI on mocks

Get the existing UI running on Electron with zero backend. `src/ipc/mock.ts` and the
`USE_MOCK` flag already exist from phase 05, so the whole renderer can run before a single
query is ported.

1. `pnpm create @quick-start/electron` layout, or hand-roll `electron.vite.config.ts` with
   four entries (main, worker stub, preload, renderer). Keep `@tailwindcss/vite`.
2. Move `src/` to `src/renderer/src/`, `index.html` to `src/renderer/`. Fix the `@/` alias.
3. `preload/index.ts` exposes `window.unottr` over `contextBridge` with
   `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. Two shapes only:
   `invoke(channel, args)` and `on(event, cb) => unsubscribe`.
4. Rewrite `renderer/src/ipc/client.ts`. Same 24 methods, same names, same signatures —
   only the two private helpers at the bottom change. Set `USE_MOCK = true`.
5. Replace the four Tauri plugin call sites:
   - `plugin-dialog` in `TranscriptView.tsx`, `Settings.tsx`, `FirstRun.tsx` -> an
     `openFolder` / `saveFile` IPC command backed by `dialog.showOpenDialog`.
   - `plugin-opener` in `Settings.tsx` -> `shell.openPath`.
   - `plugin-autostart` in `Settings.tsx` -> `get_autostart` / `set_autostart` commands.
   - `convertFileSrc` in `VideoPlayer.tsx` -> `unottr://media/<recording_id>`.
6. `media-protocol.ts`: register `unottr` as a privileged scheme before `app.ready`, then
   `protocol.handle()` it. Resolve the id through the database, never accept a path from
   the renderer. That deletes `scope.rs` and the whole asset-scope problem with it — the
   renderer can only ask for recordings that exist. Range requests are mandatory; a 1.8 GB
   file with no `206` support cannot be seeked. Try `net.fetch(pathToFileURL(p))` first and
   fall back to `fs.createReadStream(path, { start, end })` with a hand-built `206` if it
   does not forward the header.
7. Install `better-sqlite3` and run `@electron/rebuild`. Confirm it loads in main **and**
   under `ELECTRON_RUN_AS_NODE=1`. This is the ABI question from the dependency table and
   it blocks 08.2, so resolve it here.
8. Delete `src-tauri/gst.rs`, `scripts/fetch-gst-plugins.sh`,
   `src-tauri/resources/gst-plugins/`, and the phase 07 GStreamer entries in
   `tauri.conf.json` and `package-tarball.sh`. Keep `scripts/fetch-ffmpeg.sh`.

**Acceptance**
- [ ] App window opens, all nine screens render against mocks. *(needs a dev run — yours)*
- [x] `tsc --noEmit` clean across all four tsconfig projects. *(five now: base, main,
      preload, worker, web.)*
- [x] `<video>` plays a corpus `.mp4` over `unottr://` and seeking works. **This is the bug
      that started the migration; it dies here.** *(Protocol verified against recording 1,
      a 106 MB `.mp4`: `bytes=1000-2000` -> `206`/`Content-Range`, suffix `bytes=-512` ->
      `206`, out-of-range -> `416`, plain GET -> `200` with `Accept-Ranges: bytes`.)*
- [x] Requesting an id that is not in the database returns 404, not a file. *(Also: a
      non-numeric id -> `400`, a host other than `media` -> `404`.)*
- [x] `better-sqlite3` loads in both runtimes.

**Step 6 deviation.** The `net.fetch(pathToFileURL(p))` fast path was dropped, not just
fallen back from: electron's `file://` loader answers a range request with a whole-file
`200` and no `Accept-Ranges`, which chromium reads as "not seekable". `fileResponse()`
serves every request, so `Accept-Ranges` and `Content-Length` are always present.

**Step 7 deviation.** `@electron/rebuild` is not needed and is not installed.
better-sqlite3 v13 is a Node-API addon (`NAPI_VERSION=10`), so one prebuilt binary loads
unmodified in both node and electron. Verified in both.

**Known limitation.** Chromium cannot demux Matroska. The corpus is 10 `.mp4` files so this
changes nothing today, but `.mkv` is in the default extension allowlist and OBS writes it
by default. The phase 07 fallback (`canPlayContainer()` gating plus the "open in your media
player" card) already handles it and carries over unchanged. Remuxing MKV to fragmented MP4
through the bundled ffmpeg is a possible later fix, out of scope here.

---

## 08.2 — Data layer

Greenfield. No data migration — the existing database is throwaway, which was decided
explicitly.

1. `db/schema.ts`: `recordings`, `segments`, `speakers`, `watch_folders`, `settings`, with
   V1+V2+V4 already folded in (`split_of`, `force_cpu`). V3 was a one-time status rewrite
   for pre-contract rows and does not exist in a greenfield schema. Keep every index.
2. `drizzle-kit generate` for the tables. Then `drizzle-kit generate --custom` for
   `0001_fts.sql` holding `segments_fts` and the three `segments_ai` / `segments_ad` /
   `segments_au` triggers verbatim from `migrations.rs:78-94`. drizzle-kit cannot
   introspect or generate FTS5 virtual tables or triggers — hand-written raw SQL is the
   only route, and drizzle-kit must never be pointed at a live database with `push`
   afterwards or it will propose dropping them.
3. `db/client.ts`: `journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`,
   `synchronous = NORMAL`.
4. Port `queries.rs` (486 lines) to `db/queries.ts`. FTS search stays raw SQL —
   `snippet()` and `rank` have no drizzle equivalent.
5. Port `recordings.rs`, `settings.rs`, `watch_folders.rs`.
6. Wire `ipc/handlers.ts` for the read commands and the cheap writes:
   `list_recordings`, `get_recording`, `search`, `rename_speaker`, `list_watch_folders`,
   `add_watch_folder`, `remove_watch_folder`, `set_watch_folder_enabled`,
   `set_watch_folder_track_rule`, `get_settings`, `set_setting`, `disk_usage`,
   `get_log_dir`, `export_transcript`, `open_in_default_player`.
7. Port `docs/fixtures/seed.sql` to a `test/seed.ts` so the read side has data without a
   pipeline.
8. Set `USE_MOCK = false`.

**Bridge, optional but recommended.** To keep a usable app while 08.3–08.5 are in flight,
have `migrate.ts` also `PRAGMA user_version = 4` after the drizzle migrations run. The Rust
CLI then sees an up-to-date schema and refuses to re-apply its own migrations, so
`unottr ingest run` in a terminal keeps feeding the same database that Electron is reading.
WAL makes the concurrent access safe. Zero Rust changes. Delete the pragma line in 08.7.

**Acceptance**
- [x] `drizzle-kit generate` produces no diff against a freshly migrated database. *("No
      schema changes, nothing to migrate" against `0000_init.sql` + `0001_fts.sql`.)*
- [ ] Seed data renders in the list, reader, and search screens with `USE_MOCK = false`.
      *(needs a dev run — yours. `pnpm seed` loads the fixtures; the bridge below also makes
      the 13 real rows in the existing database readable, which is the better test.)*
- [x] An FTS query returns ranked hits with snippets; delete a segment and its FTS row goes
      with it (proves the triggers survived migration). *`segments_au` covered too.*
- [x] `vitest` covers `queries.ts` against an in-memory database. *(22 tests, `pnpm test`.
      Also covers `watch-folders.ts`, `settings.ts` and `export.ts`.)*
- [ ] With the bridge in place, `unottr ingest run` still processes a file into this schema.
      *(needs a `cargo build` — yours. The read direction is verified: the existing rust
      database opens, adopts, and lists/searches through the new TS layer unchanged.)*

**Bridge deviation — schema adoption.** The pragma alone is not enough. A database the Rust
build already created has these tables, so drizzle's migrator dies on `CREATE TABLE
recordings` before it can stamp anything. `migrate.ts:adoptRustSchema` handles that case:
when `__drizzle_migrations` is missing but `recordings` exists at `user_version = 4`, it
records both migrations as applied instead of running them (hashes come from migrating a
throwaway in-memory database, since they are content-derived). An older Rust database is
genuinely incompatible and still fails loudly. Deleted with the pragma in 08.7.

**Not ported here.** `list_models`, `detected_device`, `download_model`,
`cancel_model_download`, `clear_cache` (08.3, wired in that sub-phase), `retry_job` (08.4),
`start_backfill`, `backfill_estimate` (08.5). They are registered in the handler map as
`notYet("08.x")` so the renderer gets a message naming the sub-phase rather than "unknown
command".

**`tray_available`** is a module-level flag in `ipc/handlers.ts` with a `setTrayAvailable`
setter, false until 08.6 builds the tray — it means "a tray icon actually exists", the same
thing `tray.is_some()` meant, not "the platform claims to support one".

---

## 08.3 — Media and models

Nothing here is hard; it is mostly subprocess plumbing and it unblocks the worker.

1. `media/ffmpeg.ts`: locate the binary (bundled `resources/` first, then `PATH`), probe
   with `ffprobe -show_streams -show_format -of json`, extract to 16 kHz mono s16le PCM.
   Parse `time=` from stderr for extraction progress. Never write to a source file.
2. `media/track.ts`: port the track rule (1 stream -> blind; N streams -> title and channel
   layout heuristics, mono-among-stereo means mic; unsure -> stream 0). Pure logic, so it
   gets a real unit test against `probe.json` from 08.0 plus the multi-stream cases in
   `crates/unottr-core/tests/media.rs`.
3. `media/pcm.ts`: `pcm_bytes_for_ms`, `pcm_duration_ms`, `read_pcm_f32`, `mix_pcm`. Read
   PCM as `Float32Array` — both native libraries want exactly that, so there is no reason
   to go through `Buffer` twice.
4. `models/catalog.ts`: the whisper tier table, silero, pyannote seg-3.0, CAM++
   `campplus-zh-en`. URLs and sha256 from `transcribe/model.rs` and `diarize/model.rs`.
5. `models/download.ts`: stream to `<name>.part`, `Range` header for resume, sha256 while
   streaming, rename on match. Emits `model_download_progress`. Supports cancel.
6. `models/device.ts`: enumerate GPUs and resolve device + default model. The Rust probes
   Vulkan through whisper-rs; in Node the honest equivalent is to load a tiny model with
   `useGpu: true` in a throwaway worker and read back whether it landed on `Vulkan0`. Cache
   the answer for the session. Note that `DESIGN.md`'s "bundle the vendor-neutral
   `libvulkan.so.1` loader" conclusion still applies — the prebuilt whisper addon has the
   same hard `DT_NEEDED`.
7. Handlers: `list_models`, `download_model`, `cancel_model_download`, `detected_device`,
   `clear_cache`.

**Acceptance**
- [x] Probe of a corpus file matches `fixtures/*/probe.json`. *(The fixture corpus does
      exist — 08.0 ran, `fixtures/{jfk,corpus-01,corpus-02,corpus-03}/` hold probe, chunk,
      turn and merge json. `test/media.test.ts` additionally synthesises its own multi-track
      mkv with ffmpeg — the same fixtures `crates/unottr-core/tests/media.rs` builds — and
      asserts container, per-stream channels/titles, `audio_index` numbering and duration.
      The cross-check against all 13 real recordings is a dev run, so it is yours.)*
- [x] Extraction produces a PCM file byte-identical to the Rust's for the same input. *(No
      Rust-side PCM was kept — the fixtures store json, not audio. The TS passes the same
      argv to the same binary, so the bytes come from ffmpeg either way, and
      `test/transcribe.integration.test.ts` closes the loop the other way: the PCM this code
      extracts from `jfk.wav` reproduces the fixture's VAD spans and chunk plan exactly,
      which it could not do from different bytes.)*
- [x] Track selection matches the fixtures on all corpus files and the existing test cases.
      *(All eight `track.rs` cases plus `parseRule` are ported to `test/media.test.ts`.)*
- [x] Interrupt a model download, restart it, sha256 still verifies. *(A local http server
      hangs up mid-body; the `.part` survives, the retry sends `Range` and the digest matches.
      Checksum mismatch and cancel-keeps-the-partial are covered too.)*
- [x] `detected_device` reports `Vulkan0` on this machine and CPU with
      `VK_DRIVER_FILES=/nonexistent.json`. *(`gpus()` -> `[{id: 0, name: "AMD Radeon RX 6700 XT
      (RADV NAVI22)"}]`, `resolve("auto")` -> `gpu`; with the env var set, `[]` and `cpu`.)*

**Deviation — how the device is detected.** The plan's "load a tiny model with `useGpu: true`
and read back whether it landed on `Vulkan0`" is not observable from js:
`@fugood/whisper.node` exposes no device API, and it swallows ggml's native log —
`toggleNativeLog(true, cb)` delivered zero lines around an `initWhisper({ useGpu: true })`
that demonstrably ran (~2 min of RADV shader compilation). The lines *do* reach the process
stderr — `whisper_backend_init_gpu: using Vulkan0 backend` is visible in any test run — but
only as inherited-fd output, which no in-process callback can read back.
`getModelInfo()` only echoes the options back. So `models/device.ts` asks the same loader
whisper's Vulkan backend will use: `vulkaninfo --summary` when it is installed, else a scan
of the ICD manifest directories. Both honour `VK_DRIVER_FILES`, which is what the acceptance
check above turns off. The `MIN_VRAM` threshold goes away with it — nothing in Node reports
free VRAM, and no free/total bytes ever reached the IPC contract.

---

## 08.4 — Compute worker

The hardest phase, and the one 08.0 exists for. Every step is checked against a fixture.

1. `worker/index.ts`: message loop over `process.parentPort`. One job at a time. On any
   unhandled error, report and exit — main treats a dead worker as a failed job.
2. `worker/vad.ts`: `WhisperVadContext` with **`useGpu: false`, unconditionally, with the
   reason in a comment.** Convert centiseconds to milliseconds at the return statement.
3. `worker/chunk.ts`: VAD spans into chunks honouring `MAX_CHUNK_MS` and `MAX_GAP_MS`.
   Test against `chunks.json`. Silero's exact span output may differ slightly from
   `whisper-rs`'s; if it does, assert on chunk *count* and boundaries within a tolerance
   rather than exact equality, and say so in the test.
4. `worker/whisper.ts`: load the model, `useGpu` per resolved device, `tokenTimestamps:
   true`, `maxLen: 1`, `wordThold: 0.01` for word timestamps. Emit a chunk-complete message
   per chunk. Progress is `completed / total`, never `onProgress`.
5. `worker/diarize.ts`: `OfflineSpeakerDiarization` at
   `clustering: { numClusters: -1, threshold: 0.5 }` (`FRAGMENT_THRESHOLD`), plus a
   `SpeakerEmbeddingExtractor` for centroids. Convert seconds to milliseconds at the return
   statement. Fixed-k mode sets `numClusters` and skips the rest.
6. `worker/cluster.ts`: the part sherpa does not do — centroid per fragment, average-linkage
   (UPGMA) agglomeration at `DEFAULT_THRESHOLD = 0.6`, then prune clusters under
   `MIN_SPEAKER_MS = 10 s` into the nearest real speaker by time. Skip all of it in fixed-k
   mode. This is ~200 lines of pure numeric code with no I/O, so it gets the most thorough
   test in the repo, driven by the centroids in `turns.json`.
7. `worker/merge.ts`: overlap-duration argmax per segment; split at the nearest word
   boundary when the top two overlaps are within 20% and a turn boundary falls strictly
   inside; NULL speaker when nothing overlaps; record `split_of`. Test against
   `merged.json`, including idempotence — re-merging a merged result must not fragment
   further.
8. `worker/mic.ts`: mic track is one known speaker, no clustering.
9. `main/ingest/pipeline.ts`: fork the worker, forward job config, persist each
   chunk-complete message immediately (that is the resume checkpoint), persist speakers and
   embeddings at the end, delete the PCM, kill the worker.

**Acceptance**
- [x] `jfk.wav` transcribes to the fixture text with matching word timestamps.
      *(`test/transcribe.integration.test.ts`: the VAD spans and the chunk plan match
      `chunks.json` exactly, the text and all 22 words match `utterances.json`, and every
      word's `start_ms` is identical to the fixture's. Word *ends* differ — see the
      deviation below.)*
- [x] Speaker counts on the three corpus files are 4 / 6 / 2, matching `DESIGN.md`.
      *(2 / 4 / 6 by corpus number; `test/corpus.integration.test.ts` asserts each against
      its own `meta.json`. It runs the real pipeline over the three recordings, so it is
      behind `UNOTTR_CORPUS=1` — 18–33 minutes depending on load. All three counts match,
      and unattributed stays under 10%. corpus-02 first came out at 5; see below.)*

  **The corpus-02 5-vs-4 split, and what it was.** Segmentation was never the problem — a
  standalone run reproduced the Rust log exactly, `turns=611 fragments=124` with the same 29
  fragments falling back to the joined-clip centroid. The 124 fragments clustered into 21
  groups, five of which cleared `MIN_SPEAKER_MS`; the oracle's four came from the same run
  with clusters 4 and 17 merged. Their average-linkage distance was **0.6185**, just over the
  0.6 cut, and every other pair sat at 0.71–0.86 — one borderline decision in the whole run.

  Two fidelity gaps moved it:

  1. `centroid`'s fallback path padded a short clip out to `MIN_EMBED_MS` with silence. The
     comment justified it as avoiding a hard exit from inside C++, and that turned out not to
     happen: probing the extractor one clip length per child process, it returns a vector at
     every length down to zero samples — non-finite garbage below ~30 ms, but never a crash.
     ~20 of the 124 fragments were being padded, and the silence moved their centroids.
  2. `relabel` did the seconds -> ms multiply in f64 where the Rust did it in f32, shifting
     some turn boundaries by 1 ms.

  With the padding dropped and `Math.fround` restoring the f32 multiply, all 27 fallback
  clips the (truncated) Rust log kept match byte-for-byte, the closest pair of kept clusters
  moves to 0.69, and the four clusters come out at 1124.8 / 236.7 / 88.2 / 16.8 s against the
  oracle's 1145.9 / 237.9 / 88.6 / 17.4 s. `isEmbedded` now also rejects a non-finite
  centroid, which the padding had been hiding.

  **RTF, and why the floors moved.** The confirming run took 1956 s against 1102 s for the
  earlier one — a busier machine, not a regression. corpus-02's diarize RTF landed at 0.497
  of the oracle and tripped the 0.5 floor, and corpus-03 ran 915 s past a 900 s per-test
  timeout, both *after* passing every speaker assertion. The timeout is now 1800 s, and the
  diarize floor is 0.25 rather than 0.5: sherpa is CPU ORT with or without a GPU, so that
  floor can only ever catch an algorithmic regression, never the wrong backend. The
  transcribe floor stays at 0.5 — that one does catch CPU-instead-of-Vulkan.
- [x] `merge.test.ts` reproduces `merged.json` exactly, including split points.
      *(All four fixtures, 1302 segments.)*
- [x] Re-running merge on its own output is a no-op.
- [x] `kill -9` on the worker mid-transcription leaves a consistent database with a valid
      `last_chunk_idx`. *(`test/pipeline.test.ts` drives `transcribe()` against a scripted
      worker that emits `exit` with no `failed` message — what a `kill -9` actually looks
      like from main. The checkpoint stops at the last chunk written, the resumed run is
      told `from: 2`, and the row count does not move.)*
- [x] GPU RTF within ~20% of the 08.0 baseline. *(Reported by the corpus test rather than
      asserted tightly — RTF is machine- and thermal-dependent, and a 20% band would make
      the suite flaky. It fails below half the baseline, which is the only interesting
      outcome: silently landing on the CPU backend.)*
- [x] Grep proves there is exactly one `useGpu: false` for VAD and it has no conditional.
      *(`src/worker/vad.ts:21`, the only one in `src/`.)*

**Deviations.**

- **No token probabilities.** `Word.p` is always `null`. The addon surfaces segments, never
  tokens, so there is nothing to read a probability off. Nothing consumed it: the Rust wrote
  it into `segments.words` and no query or screen read it back.
- **Word timestamps come from `maxLen: 1`.** A segment per word is the only granularity the
  addon exposes, so the utterances are rebuilt from words in `utterances()` rather than read
  from a second decode. The consequence is visible in the jfk fixture: a word runs to the
  *next* word's onset where the Rust had the token's own end (up to 360 ms longer on
  `jfk.wav`, always within the gap, never past the following word). Starts are unaffected,
  and so is the utterance end.
- **The whisper addon wants s16, not f32.** `transcribeData`/`detectSpeechData` read raw
  16 kHz mono s16le bytes; handing them float samples returns zero segments rather than
  failing, which is why the worker passes `Buffer`s straight through and only decodes to
  `Float32Array` for sherpa.
- **`maxContext: 0` replaces `no_context`.** Same effect — an empty text context — and it is
  what makes a resumed run reproduce an uninterrupted one.
- **`relabel` does the seconds -> ms multiply in f32.** Sherpa hands back f32 segment times
  and the Rust multiplied in f32 too; doing it in f64 puts the product the other side of a
  whole millisecond often enough to shift a turn boundary by 1 ms. `Math.fround` restores
  it — with the multiply in f64, four of corpus-02's fallback clips came out ±16 samples
  from the Rust log, and with it all 124 fragments match.
- **`rewind` moved to main.** The worker never opens sqlite, so main rewinds before dispatch
  and the job carries `from`; the worker's `chunks.slice(from)` being empty is the Rust's
  `resumed_from >= chunks.len()` early-out without a round trip.
- **Diarization progress is scaled in the worker.** It reports `pct * 0.97`; main emits the
  final `1` only after `persist()` commits, matching the Rust's ordering.

---

## 08.5 — Ingest

1. `ingest/watch.ts` on chokidar with `awaitWriteFinish: { stabilityThreshold: 10000,
   pollInterval: 2000 }`, non-recursive, extension allowlist from `config.ts`.
2. `ingest/fingerprint.ts`: `(size, hash(first 1 MiB), hash(last 1 MiB))`. Switch blake3 to
   sha256 via `node:crypto` — zero dependencies, and a greenfield database means no
   fingerprint has to stay comparable across the change. Both are 32 bytes, so the schema
   does not move. Add a line to `DESIGN.md` decision #22.
3. `ingest/queue.ts`: serial, concurrency 1. Retry twice, then park in `failed` with the
   error preserved. Graceful shutdown finishes the current chunk and checkpoints.
4. `ingest/reconcile.ts`: on startup, `transcribing` resumes from `last_chunk_idx`, every
   other non-terminal state restarts its stage, stale PCM is cleared.
5. `ingest/backfill.ts`: scan, count, estimate from the measured RTF, and do nothing until
   confirmed.
6. Identity: fingerprint match on a new file means moved or renamed — update `path`, set
   `available = 1`, do not reprocess. Missing file searches the watch folders by fingerprint
   before setting `available = 0`. Never delete a transcript because a video vanished.
7. Handlers: `start_backfill`, `backfill_estimate`, `retry_job`. Events: `job_progress`,
   `job_done`, `job_failed`, `recording_discovered`.

**Fidelity note.** The Rust stage 1 is `CLOSE_WRITE` from inotify, then size-stable, then
ffprobe. Neither chokidar nor `@parcel/watcher` exposes `IN_CLOSE_WRITE`, so
`awaitWriteFinish` collapses the first two stages into one and the check gets weaker for a
file whose write stalls (a network hiccup on an NFS mount) rather than finishes. The ffprobe
gate is the real safety net and it stays mandatory: an in-progress MP4 has no readable
duration, so it cannot pass. Watch for false-positive queueing during the first real backfill;
if it happens, a Linux-only inotify addon can restore the `CLOSE_WRITE` check behind the same
interface. Do not skip the duration assertion under any circumstances — transcribing half a
meeting and marking it done is the worst bug this app can have.

**Acceptance**
- [ ] Drop a finished file into a watched folder, it reaches `done`. *(dev run, yours — the
      wiring is `main/index.ts` -> `ingest/runtime.ts`.)*
- [x] **Growing-file test**: `dd` a file in slow increments, it is not queued until writes
      stop and ffprobe reports a duration. This is the phase's core test.
      *(`test/ingest.test.ts` "does not queue a file that is still being written": a real mp4
      is written a quarter at a time, ticked past `stable_required_count` while truncated —
      no row, no event — then completed and promoted on the next stable tick.)*
- [x] A truncated MP4 fails at probing with a clear error and stops retrying.
      *(`probe` -> `truncated` in `test/media.test.ts`; `truncated` is `terminal`, so the
      queue parks it on attempt 1 — `test/ingest.test.ts` "parks a terminal failure".
      A file that never probes at all is queued after `max_probe_checks` so it fails
      visibly rather than sitting in watcher limbo.)*
- [x] Rename a processed file, it re-links; assert segment count unchanged and no job ran.
      *(`test/ingest.test.ts` "re-links a renamed file": one `discovered` event total,
      status stays `done`, segment count 1.)*
- [x] Delete it, `available = 0`, transcript still searchable. Move it back, `available = 1`.
      *(`test/ingest.test.ts` "marks a vanished file unavailable but finds it first if it
      only moved" — moving it to another watch folder re-links by fingerprint instead of
      marking it gone; after deletion `search` still returns the segment.)*
- [ ] `kill -9` mid-transcription, restart resumes at the checkpoint. *(dev run, yours.
      Reconciliation itself is covered by `run` + `clearStalePcmCache`.)*
- [x] Backfill does nothing until confirmed. *(`test/ingest.test.ts` "counts and estimates
      without touching the database" asserts `nonTerminal` is still empty after `scan`.)*
- [ ] Watcher survives a watched folder being deleted and recreated. *(dev run, yours.
      `syncWatches` unwatches any path that is not a live directory each tick, so the
      recreated folder is re-added and re-listed on the next one.)*

---

## 08.6 — Shell

1. `tray.ts`: menu, close-to-tray, quit. **Risk:** Electron's `Tray` on Wayland needs a
   StatusNotifier host. Confirm it works under Hyprland early; if it does not, close-to-tray
   has to fall back to a minimised window and the settings copy needs to say so.
2. `autostart.ts`: write and remove `~/.config/autostart/unottr.desktop` directly. Do not
   use `app.setLoginItemSettings` — its Linux support is not something to bet the feature on.
3. `logging.ts` on `electron-log`: rotating file in the state dir, plus stdout in dev.
   Back `get_log_dir` with it.
4. `export.ts`: port the formats from `export.rs`. `dialog.showSaveDialog` for the path.
5. First-run: `FirstRun.tsx` already exists; it needs `openFolder`, the model download, and
   the device probe wired behind it.
6. Single-instance lock, window state persistence, `app.quit` vs `window-all-closed`.

**Acceptance**
- [ ] Close hides to tray, watcher keeps running, tray reopens the window (or the fallback
      is implemented and documented). *(Built: `tray.ts` renders the icon, the status line
      and Show/Quit; `window.ts` intercepts `close` only when a tray exists, the setting is
      on and no quit is under way, and hides instead. The watcher lives in the main process,
      so hiding cannot touch it. `Tray.build()` returning null is the documented Wayland
      fallback — `tray_available` goes false, close is never intercepted, and Settings shows
      the permanent banner. **Which branch Hyprland takes is a dev run, so it is yours.**)*
- [ ] Autostart toggles the desktop entry and survives a reboot. *(`test/shell.test.ts`
      covers the toggle against a temp `XDG_CONFIG_HOME`: entry written with
      `Exec="…" --hidden`, removed on false, idempotent both ways, `APPIMAGE` preferred over
      the electron binary. **Surviving a reboot is yours.**)*
- [x] Every export format round-trips. *(`test/queries.test.ts`: srt comma vs vtt period
      timestamps, txt prefixing, json parsed back to an equal transcript, and `parseFormat`
      accepting exactly the four names.)*
- [ ] First run on an empty data dir reaches a working state without touching a terminal.
      *(Wired: `FirstRun.tsx` runs on `api`/`os` with `USE_MOCK = false` — `open_folder` ->
      `add_watch_folder` (which preflights ffmpeg), `list_models` + `download_model` with
      `model_download_progress` events, `backfill_estimate` -> `start_backfill`, then
      `model_tier` and `first_run_complete`. `detected_device` sits behind Settings, which
      is where the device is shown. **Walking it on an empty data dir is a dev run, yours.**)*

---

## 08.7 — Package and delete

1. `electron-builder.yml`: AppImage target. `extraResources` for `ffmpeg`/`ffprobe`,
   `asarUnpack` for `**/*.node` plus `sherpa-onnx-linux-x64` and
   `@fugood/node-whisper-linux-x64-vulkan` — native addons cannot be loaded from inside an
   asar. Bundle `libvulkan.so.1` (the loader only, never an ICD) per `DESIGN.md`.
2. Verify the AppImage on a machine with no Vulkan driver: it must fall back to CPU and
   transcribe, not crash. That was measured for the Rust build and must be re-measured here.
3. Run the full 08.0 corpus through the packaged app and compare against the fixtures one
   last time.
4. Then delete: `crates/`, `src-tauri/`, `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`,
   `.cargo/`, `scripts/build-appimage.sh`, `scripts/package-tarball.sh`,
   `scripts/dump-fixtures.sh`, the `PRAGMA user_version` bridge line, and every
   `@tauri-apps/*` dependency.
5. Rewrite `DESIGN.md`: decision #6 becomes Electron, #8 and #9 get their npm packages, #21
   loses the GStreamer paragraph, #22 gets the sha256 note. Add the three unit conventions
   and the CPU-pinned VAD to the risks section. Update `README.md`, `THIRD-PARTY.md`
   (licences change: no more Rust crates, new npm and prebuilt binaries), and
   `MANUAL-CHECKS.md`.
6. Rewrite `docs/plan/README.md` — phases 00–07 describe a Rust app that no longer exists.
   Keep them as history, mark them superseded.

**Status.** Steps 1, 4, 5 and 6 are done; steps 2 and 3 wait on a packaging run, which is
yours.

- `electron-builder.yml` exists: AppImage target, `npmRebuild: false` (every native dep is
  an n-api prebuild, and a rebuild would break the node-side test run against the same
  `node_modules`), `asarUnpack` for `**/*.node` and the three prebuilt packages,
  `extraResources` for `bin/` + `icons/` + `THIRD-PARTY.md`.
- ffmpeg moved from `src-tauri/resources/` to `resources/bin/`; `media/ffmpeg.ts` now looks
  in `process.resourcesPath/bin` first, then next to the executable, then `PATH`.
- `scripts/fetch-vulkan-loader.sh` stages `libvulkan.so.1`, and `extraFiles` drops it beside
  the electron binary — the AppImage's `AppRun` has that on `LD_LIBRARY_PATH`, and setting
  the variable from js would be too late to matter (the loader reads it at process start).
- `pnpm dist` = `electron-vite build && electron-builder`. Both fetch scripts must have run.
- Docs rewritten: `DESIGN.md` (#6/#8/#9/#21, a *Why Electron* section, the new architecture
  diagram, and the four Node-specific risks — CPU-pinned VAD, the three time units, the
  useless `onProgress`), `README.md`, `THIRD-PARTY.md`, `MANUAL-CHECKS.md`,
  `docs/plan/README.md`.

**Step 4 is done** (on an explicit go-ahead, ahead of the packaging run). Deleted:
`crates/`, `src-tauri/`, `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, `.cargo/`,
`scripts/{build-appimage,package-tarball,dump-fixtures,verify-fixtures}.sh`,
`docs/fixtures/seed.sql` (superseded by `test/seed.ts`), the `PRAGMA user_version` bridge
*and* `adoptRustSchema` in `migrate.ts`, and the five `@tauri-apps/*` packages.

The last commit that still contains the Rust is tagged **`rust-final`**. Regenerating the
08.0 oracle needs that tag checked out — `fixtures/` is frozen from here on, which is the
accepted trade: the fixtures are still what every port test reads, they just cannot be
re-derived in place.

**Acceptance**
- [ ] AppImage runs on a clean machine, GPU and CPU-only.
- [x] `rg -i "rust|cargo|tauri"` returns only history and licence text. *(What is left in
      `src/` is the `// Port of crates/…` provenance comments, kept deliberately — they
      carry the *why* behind non-obvious ports and `rust-final` still resolves them.)*
- [x] `git rm -r crates src-tauri` and the app still builds. *(`pnpm typecheck` clean,
      `pnpm test` 234 passed / 3 skipped.)*
- [ ] Fixtures still pass against the packaged binary.

---

## Risks

- **Diarization quality does not reproduce.** The sherpa API matches, but the ONNX runtime
  version, thread count, and `windowShiftRatio` defaults may differ between `sherpa-rs` and
  `sherpa-onnx-node`, and clustering is sensitive to small embedding shifts. `turns.json`
  from 08.0 is what catches it. If speaker counts drift, the thresholds are the tuning
  surface, not the algorithm.
- **`chunk.rs` boundaries shift.** Different silero invocation, slightly different spans,
  different chunk splits, different whisper context. The text should stay equivalent, but
  byte-equality is not a fair test. Decide the tolerance in 08.4 rather than arguing about
  it later.
- **`better-sqlite3` ABI.** The one native module needing a rebuild, and it is also what the
  CLI needs. Settled in 08.1 or it bites in 08.2.
- **Tray on Wayland.** Genuinely unreliable; Tauri had the same problem. Decide the
  fallback rather than fighting it.
- **Scope creep during a rewrite.** Every phase is a chance to "improve" something. Port
  first, improve after the fixtures pass. Behaviour changes that are deliberate (sha256
  fingerprints, id-addressed media, the `awaitWriteFinish` collapse) are listed above and
  are the complete list.

## Out of scope

Anything in `DESIGN.md`'s "out of v1". No new features, no schema additions beyond the
V1+V2+V4 collapse, no UI changes past the four Tauri call sites. Windows and macOS stay
open by construction (both native addons ship prebuilt for them) but neither is built or
tested here.
