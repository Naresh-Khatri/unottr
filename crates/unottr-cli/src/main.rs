//! Headless driver for the pipeline. Phases 01-03 are built and validated through this
//! before any UI exists.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use unottr_core::diarize;
use unottr_core::ingest::{self, IngestConfig, IngestService, PipelineConfig};
use unottr_core::media::{FfmpegCli, MediaBackend, Selection, TrackRule};
use unottr_core::transcribe::{self, Device, Job, ModelStore, Options};
use unottr_core::{CancelToken, Database, Event, ModelSpec, Paths};

#[derive(Parser)]
#[command(name = "unottr", version, about = "Local meeting transcription")]
struct Cli {
    /// Log to stderr only; skip the rotating log file
    #[arg(long, global = true)]
    quiet: bool,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Inspect a media file's streams and duration (phase 01)
    Probe {
        file: PathBuf,
        /// Also print which track(s) the pipeline would pick
        #[arg(long)]
        select: bool,
    },
    /// Extract 16 kHz mono pcm (phase 01)
    Extract {
        file: PathBuf,
        #[arg(long)]
        out: Option<PathBuf>,
        /// Audio track to extract; defaults to the auto-selected one
        #[arg(long)]
        track: Option<u32>,
    },
    /// Transcribe a recording or a raw .pcm (phase 02)
    Transcribe {
        file: PathBuf,
        /// Model name from `unottr models list`; defaults to the best one for the device
        #[arg(long)]
        model: Option<String>,
        #[arg(long, value_enum, default_value_t = DeviceArg::Auto)]
        device: DeviceArg,
        /// Spoken language, e.g. `en`. Omit to auto-detect.
        #[arg(long)]
        language: Option<String>,
        #[arg(long)]
        threads: Option<i32>,
        /// Download the model if it is missing instead of erroring
        #[arg(long)]
        download: bool,
        /// Print the transcript when it finishes
        #[arg(long)]
        print: bool,
        /// Phase 08.0: write chunks.json and utterances.json into this directory
        #[arg(long, value_name = "DIR")]
        dump_json: Option<PathBuf>,
    },
    /// Manage the local whisper models
    #[command(subcommand)]
    Models(ModelCommand),
    /// Label who spoke when, over an already-transcribed recording (phase 03)
    Diarize {
        file: PathBuf,
        /// Cosine distance at which two voices stop being the same person. Lower splits
        /// more. Ignored when --speakers is given.
        #[arg(long)]
        threshold: Option<f32>,
        /// Force an exact speaker count instead of letting clustering decide
        #[arg(long)]
        speakers: Option<u32>,
        /// Embedding model name from `unottr models list`
        #[arg(long)]
        embedding_model: Option<String>,
        /// Download missing models instead of erroring
        #[arg(long)]
        download: bool,
        /// Print the labelled transcript when it finishes
        #[arg(long)]
        print: bool,
        /// Phase 08.0: write turns.json and merged.json into this directory
        #[arg(long, value_name = "DIR")]
        dump_json: Option<PathBuf>,
    },
    /// Manage watched folders (phase 04)
    #[command(subcommand)]
    Watch(WatchCommand),
    /// Run the ingest watcher + worker, or backfill an existing folder (phase 04)
    #[command(subcommand)]
    Ingest(IngestCommand),
    /// Inspect the local database
    #[command(subcommand)]
    Db(DbCommand),
}

#[derive(Subcommand)]
enum WatchCommand {
    /// Start watching a folder for new recordings (idempotent)
    Add { path: PathBuf },
    /// Stop watching a folder. Existing recordings and transcripts are untouched.
    Remove { id: i64 },
    /// List configured watch folders
    List,
}

#[derive(Subcommand)]
enum IngestCommand {
    /// Watch every configured folder and process discovered recordings until ctrl-c
    Run {
        /// Whisper model name; defaults to the best one for the device
        #[arg(long)]
        model: Option<String>,
        /// Diarization embedding model name
        #[arg(long)]
        embedding_model: Option<String>,
        #[arg(long, value_enum, default_value_t = DeviceArg::Auto)]
        device: DeviceArg,
        #[arg(long)]
        language: Option<String>,
        #[arg(long)]
        threads: Option<i32>,
        #[arg(long)]
        threshold: Option<f32>,
        #[arg(long)]
        speakers: Option<u32>,
        /// Download missing models instead of erroring
        #[arg(long)]
        download: bool,
    },
    /// Report what a folder full of pre-existing files would cost to process. Does nothing
    /// until confirmed with --yes.
    Backfill {
        folder: PathBuf,
        /// Actually enqueue the files (registers the folder as watched, too)
        #[arg(long)]
        yes: bool,
    },
}

#[derive(Subcommand)]
enum ModelCommand {
    /// Show every known model and whether it is downloaded
    List,
    /// Download a model (resumes a partial file)
    Get { name: String },
    /// Report which compute device would be used
    Device,
}

#[derive(Clone, Copy, clap::ValueEnum)]
enum DeviceArg {
    Auto,
    Gpu,
    Cpu,
}

impl From<DeviceArg> for Device {
    fn from(d: DeviceArg) -> Self {
        match d {
            DeviceArg::Auto => Device::Auto,
            DeviceArg::Gpu => Device::Gpu,
            DeviceArg::Cpu => Device::Cpu,
        }
    }
}

#[derive(Subcommand)]
enum DbCommand {
    /// Print resolved on-disk locations
    Path,
    /// Create or migrate the database
    Migrate,
    /// Delete the database and start over
    Reset {
        #[arg(long)]
        yes: bool,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let paths = Paths::resolve().context("resolving application directories")?;

    let _guard = if cli.quiet {
        tracing_subscriber::fmt()
            .with_env_filter(
                tracing_subscriber::EnvFilter::try_from_default_env()
                    .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
            )
            .with_writer(std::io::stderr)
            .init();
        None
    } else {
        paths.ensure()?;
        Some(unottr_core::logging::init(&paths)?)
    };

    match cli.command {
        Command::Db(cmd) => db(cmd, &paths),
        Command::Probe { file, select } => probe(&file, select),
        Command::Extract { file, out, track } => extract(&file, out, track, &paths),
        Command::Models(cmd) => models(cmd, &paths),
        Command::Transcribe {
            file,
            model,
            device,
            language,
            threads,
            download,
            print,
            dump_json,
        } => transcribe_file(
            &file,
            TranscribeArgs {
                model,
                device: device.into(),
                language,
                threads,
                download,
                print,
                dump_json,
            },
            &paths,
        ),
        Command::Diarize {
            file,
            threshold,
            speakers,
            embedding_model,
            download,
            print,
            dump_json,
        } => diarize_file(
            &file,
            DiarizeArgs {
                threshold,
                speakers,
                embedding_model,
                download,
                print,
                dump_json,
            },
            &paths,
        ),
        Command::Watch(cmd) => watch(cmd, &paths),
        Command::Ingest(cmd) => ingest_cmd(cmd, &paths),
    }
}

fn probe(file: &Path, select: bool) -> Result<()> {
    let backend = FfmpegCli::discover();
    let probe = backend.probe(file)?;
    let mut json = serde_json::to_value(&probe)?;
    if select {
        let choice = unottr_core::media::select(&probe, &TrackRule::Auto)?;
        json["selection"] = serde_json::to_value(&choice)?;
    }
    println!("{}", serde_json::to_string_pretty(&json)?);
    Ok(())
}

fn extract(file: &Path, out: Option<PathBuf>, track: Option<u32>, paths: &Paths) -> Result<()> {
    let backend = FfmpegCli::discover();
    let probe = backend.probe(file)?;

    let audio_index = match track {
        Some(track) => track,
        None => {
            let choice = unottr_core::media::select(&probe, &TrackRule::Auto)?;
            eprintln!("track: {}", choice.reason);
            match choice.selection {
                unottr_core::media::Selection::Blind { stream } => stream,
                // one file out for now; phase 03 is what consumes both tracks
                unottr_core::media::Selection::MicDesktop { mic, .. } => mic,
            }
        }
    };

    let out = out.unwrap_or_else(|| {
        let stem = file.file_stem().unwrap_or_default().to_string_lossy();
        paths
            .pcm_cache_dir()
            .join(format!("{stem}.t{audio_index}.pcm"))
    });

    let cancel = CancelToken::new();
    let on_signal = cancel.clone();
    let _ = ctrlc::set_handler(move || on_signal.cancel());

    backend.extract_pcm(file, audio_index, &out, &percent("extracting"), &cancel)?;
    eprintln!();

    let bytes = std::fs::metadata(&out)
        .with_context(|| format!("reading {}", out.display()))?
        .len();
    println!("{}", out.display());
    println!(
        "{bytes} bytes, {:.1}s pcm (probed {:.1}s)",
        unottr_core::media::pcm_duration_ms(bytes) as f64 / 1000.0,
        probe.duration_ms.unwrap_or(0) as f64 / 1000.0,
    );
    Ok(())
}

struct TranscribeArgs {
    model: Option<String>,
    device: Device,
    language: Option<String>,
    threads: Option<i32>,
    download: bool,
    print: bool,
    dump_json: Option<PathBuf>,
}

fn transcribe_file(file: &Path, args: TranscribeArgs, paths: &Paths) -> Result<()> {
    paths.ensure()?;
    let cancel = CancelToken::new();
    let on_signal = cancel.clone();
    let _ = ctrlc::set_handler(move || on_signal.cancel());

    let device = transcribe::resolve(args.device);
    let store = ModelStore::new(paths.models_dir());

    let spec = match &args.model {
        Some(name) => transcribe::model::find(name)
            .with_context(|| format!("unknown model `{name}`; try `unottr models list`"))?,
        None => transcribe::model::default_for(device.is_gpu()),
    };
    let model = if args.download {
        fetch(&store, spec, &cancel)?
    } else {
        store.locate(spec).with_context(|| {
            format!("run `unottr models get {}` (or pass --download)", spec.name)
        })?
    };
    // small enough that asking first would be theatre
    let vad_model = fetch(&store, &transcribe::VAD, &cancel)?;

    let pcm = tracks_for(file, paths, &cancel)?.main;
    let database = Database::open(paths.db_file())?;
    let recording_id = {
        let conn = database.connect()?;
        unottr_core::db::recordings::stub(&conn, file, None)?
    };

    let job = Job {
        recording_id,
        pcm,
        model,
        vad_model,
        device: args.device,
        options: Options {
            language: args.language,
            threads: args
                .threads
                .unwrap_or_else(transcribe::engine::default_threads),
            translate: false,
        },
        dump_dir: args.dump_json,
    };

    let started = std::time::Instant::now();
    let report = transcribe::run(&database, &job, &percent("transcribing"), &cancel)?;
    eprintln!();

    let elapsed = started.elapsed().as_secs_f64();
    let speech = report.speech_ms as f64 / 1000.0;
    println!(
        "{} chunks ({} resumed), {} segments, {speech:.1}s speech on {:?}",
        report.chunks, report.resumed_from, report.segments, report.device
    );
    println!(
        "{elapsed:.1}s wall, {:.1}x realtime over speech",
        if elapsed > 0.0 { speech / elapsed } else { 0.0 }
    );

    if args.print {
        let conn = database.connect()?;
        let mut stmt = conn.prepare(
            "SELECT start_ms, end_ms, text FROM segments WHERE recording_id = ?1 ORDER BY start_ms",
        )?;
        let rows = stmt.query_map([recording_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        for row in rows {
            let (start, end, text) = row?;
            println!("[{} -> {}] {text}", clock(start), clock(end));
        }
    }
    Ok(())
}

/// What each stage listens to.
struct Tracks {
    /// Transcription input. On a two-track file this is the mixdown: whisper has to hear
    /// both sides or half the meeting goes missing.
    main: PathBuf,
    /// `(mic, desktop)`, set only when phase 01 identified a mic track.
    split: Option<(PathBuf, PathBuf)>,
}

/// Accepts either a raw pcm or a media file, extracting (once) in the latter case. Phase 04
/// owns this orchestration properly; here it just keeps the cli usable on real recordings.
fn tracks_for(file: &Path, paths: &Paths, cancel: &CancelToken) -> Result<Tracks> {
    if file.extension().is_some_and(|e| e == "pcm") {
        return Ok(Tracks {
            main: file.to_path_buf(),
            split: None,
        });
    }

    let backend = FfmpegCli::discover();
    let probe = backend.probe(file)?;
    let choice = unottr_core::media::select(&probe, &TrackRule::Auto)?;
    let cache = paths.pcm_cache_dir();

    let extract_track = |audio_index: u32| -> Result<PathBuf> {
        let out = transcribe::pcm_path_for(&cache, file, audio_index);
        if out.exists() {
            return Ok(out);
        }
        backend.extract_pcm(file, audio_index, &out, &percent("extracting"), cancel)?;
        eprintln!();
        Ok(out)
    };

    match choice.selection {
        Selection::Blind { stream } => Ok(Tracks {
            main: extract_track(stream)?,
            split: None,
        }),
        Selection::MicDesktop { mic, desktop } => {
            let (mic, desktop) = (extract_track(mic)?, extract_track(desktop)?);
            let stem = file.file_stem().unwrap_or_default().to_string_lossy();
            let mix = cache.join(format!("{stem}.mix.pcm"));
            if !mix.exists() {
                unottr_core::media::mix_pcm(&[&mic, &desktop], &mix)?;
            }
            Ok(Tracks {
                main: mix,
                split: Some((mic, desktop)),
            })
        }
    }
}

struct DiarizeArgs {
    threshold: Option<f32>,
    speakers: Option<u32>,
    embedding_model: Option<String>,
    download: bool,
    print: bool,
    dump_json: Option<PathBuf>,
}

fn diarize_file(file: &Path, args: DiarizeArgs, paths: &Paths) -> Result<()> {
    paths.ensure()?;
    let cancel = CancelToken::new();
    let on_signal = cancel.clone();
    let _ = ctrlc::set_handler(move || on_signal.cancel());

    let store = ModelStore::new(paths.models_dir());
    let embedding_spec = match &args.embedding_model {
        Some(name) => diarize::find_embedding(name).with_context(|| {
            format!("unknown embedding model `{name}`; try `unottr models list`")
        })?,
        None => diarize::default_embedding(),
    };
    let get = |spec: &'static ModelSpec| -> Result<PathBuf> {
        if args.download || store.is_present(spec) {
            fetch(&store, spec, &cancel)
        } else {
            store.locate(spec).with_context(|| {
                format!("run `unottr models get {}` (or pass --download)", spec.name)
            })
        }
    };
    let segmentation = get(&diarize::SEGMENTATION)?;
    let embedding = get(embedding_spec)?;
    let vad_model = fetch(&store, &transcribe::VAD, &cancel)?;

    let tracks = tracks_for(file, paths, &cancel)?;
    let database = Database::open(paths.db_file())?;
    let recording_id = {
        let conn = database.connect()?;
        unottr_core::db::recordings::stub(&conn, file, None)?
    };

    // clustering would still run, but with nothing to attach itself to
    let transcribed: i64 = database.connect()?.query_row(
        "SELECT COUNT(*) FROM segments WHERE recording_id = ?1",
        [recording_id],
        |row| row.get(0),
    )?;
    if transcribed == 0 {
        anyhow::bail!(
            "no transcript for {}; run `unottr transcribe` on it first",
            file.display()
        );
    }

    let (pcm, mic_pcm) = match &tracks.split {
        Some((mic, desktop)) => (desktop.clone(), Some(mic.clone())),
        None => (tracks.main.clone(), None),
    };
    let job = diarize::Job {
        recording_id,
        pcm,
        mic_pcm,
        segmentation,
        embedding,
        vad_model,
        config: diarize::Config {
            threshold: args.threshold.unwrap_or(diarize::DEFAULT_THRESHOLD),
            speakers: args.speakers,
        },
        dump_dir: args.dump_json,
    };

    let started = std::time::Instant::now();
    let report = diarize::run(&database, &job, &percent("diarizing"), &cancel)?;
    eprintln!();

    let audio_ms = unottr_core::media::pcm_duration_ms(std::fs::metadata(&job.pcm)?.len());
    let elapsed = started.elapsed().as_secs_f64();
    println!(
        "{} speakers, {} turns over {} segments{}",
        report.speakers,
        report.turns,
        report.segments,
        if report.mic_track { " (mic track)" } else { "" },
    );
    println!(
        "{} split, {} unattributed",
        report.split, report.unattributed
    );
    println!(
        "{elapsed:.1}s wall, {:.1}x realtime",
        if elapsed > 0.0 {
            audio_ms as f64 / 1000.0 / elapsed
        } else {
            0.0
        }
    );

    if args.print {
        let conn = database.connect()?;
        let mut stmt = conn.prepare(
            "SELECT s.start_ms, s.end_ms, COALESCE(k.display_name, k.label), s.text
             FROM segments s LEFT JOIN speakers k ON k.id = s.speaker_id
             WHERE s.recording_id = ?1 ORDER BY s.start_ms, s.id",
        )?;
        let rows = stmt.query_map([recording_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;
        for row in rows {
            let (start, end, who, text) = row?;
            println!(
                "[{} -> {}] {:<10} {text}",
                clock(start),
                clock(end),
                who.unwrap_or_else(|| "?".into())
            );
        }
    }
    Ok(())
}

fn fetch(
    store: &ModelStore,
    spec: &unottr_core::transcribe::ModelSpec,
    cancel: &CancelToken,
) -> Result<PathBuf> {
    if store.is_present(spec) {
        return Ok(store.path(spec));
    }
    let path = store.ensure(spec, &percent(&format!("fetching {}", spec.name)), cancel)?;
    eprintln!();
    Ok(path)
}

/// Redraws a one-line percentage on stderr, skipping repeats.
fn percent(label: &str) -> impl Fn(f32) + '_ {
    let last = std::cell::Cell::new(-1i32);
    move |fraction: f32| {
        let done = (fraction * 100.0) as i32;
        if done > last.replace(done) {
            eprint!("\r{label} {done:3}%");
            let _ = std::io::Write::flush(&mut std::io::stderr());
        }
    }
}

fn clock(ms: i64) -> String {
    let total = ms / 1000;
    format!(
        "{:02}:{:02}:{:02}",
        total / 3600,
        (total / 60) % 60,
        total % 60
    )
}

/// Every model any stage can ask for, looked up by the name `models list` prints.
fn spec_for(name: &str) -> Option<&'static ModelSpec> {
    transcribe::model::find(name)
        .or_else(|| diarize::find_embedding(name))
        .or([&transcribe::VAD, &diarize::SEGMENTATION]
            .into_iter()
            .find(|s| s.name == name))
}

fn models(cmd: ModelCommand, paths: &Paths) -> Result<()> {
    paths.ensure()?;
    let store = ModelStore::new(paths.models_dir());

    match cmd {
        ModelCommand::List => {
            let device = transcribe::resolve(Device::Auto);
            let default = transcribe::model::default_for(device.is_gpu());
            let row = |spec: &ModelSpec, note: &str| {
                println!(
                    "{:<22} {:>6} MB  {:<12} {note}",
                    spec.name,
                    spec.size / 1_000_000,
                    if store.is_present(spec) {
                        "downloaded"
                    } else {
                        "-"
                    },
                );
            };
            println!("transcription");
            for spec in unottr_core::transcribe::MODELS {
                let note = if spec.name == default.name {
                    "(default here)"
                } else {
                    ""
                };
                row(spec, note);
            }
            row(&transcribe::VAD, "(voice activity)");
            println!("\ndiarization");
            row(&diarize::SEGMENTATION, "(segmentation)");
            for spec in diarize::EMBEDDINGS {
                let note = if spec.name == diarize::default_embedding().name {
                    "(default embedding)"
                } else {
                    ""
                };
                row(spec, note);
            }
        }
        ModelCommand::Get { name } => {
            let spec = spec_for(&name).with_context(|| format!("unknown model `{name}`"))?;
            let cancel = CancelToken::new();
            let on_signal = cancel.clone();
            let _ = ctrlc::set_handler(move || on_signal.cancel());
            let path = fetch(&store, spec, &cancel)?;
            println!("{}", path.display());
        }
        ModelCommand::Device => {
            let gpus = transcribe::gpus();
            if gpus.is_empty() {
                println!("no vulkan device");
            }
            for gpu in &gpus {
                println!(
                    "gpu {}: {} ({} MB free of {} MB)",
                    gpu.id,
                    gpu.name,
                    gpu.free_bytes / 1_000_000,
                    gpu.total_bytes / 1_000_000
                );
            }
            println!("resolved: {:?}", transcribe::resolve(Device::Auto));
        }
    }
    Ok(())
}

fn watch(cmd: WatchCommand, paths: &Paths) -> Result<()> {
    paths.ensure()?;
    let database = Database::open(paths.db_file())?;
    let conn = database.connect()?;
    match cmd {
        WatchCommand::Add { path } => {
            let path = path
                .canonicalize()
                .with_context(|| format!("resolving {}", path.display()))?;
            let wf = unottr_core::db::watch_folders::add(&conn, &path)?;
            println!("#{} {} ({})", wf.id, wf.path.display(), wf.track_rule);
        }
        WatchCommand::Remove { id } => {
            unottr_core::db::watch_folders::remove(&conn, id)?;
            println!("removed #{id}");
        }
        WatchCommand::List => {
            for wf in unottr_core::db::watch_folders::list(&conn)? {
                println!(
                    "#{:<4} {:<5} {:<6} {}",
                    wf.id,
                    wf.track_rule,
                    if wf.enabled { "on" } else { "off" },
                    wf.path.display()
                );
            }
        }
    }
    Ok(())
}

fn ingest_cmd(cmd: IngestCommand, paths: &Paths) -> Result<()> {
    match cmd {
        IngestCommand::Run {
            model,
            embedding_model,
            device,
            language,
            threads,
            threshold,
            speakers,
            download,
        } => ingest_run(
            paths,
            PipelineConfig {
                device: device.into(),
                threads,
                language,
                whisper_model: model,
                embedding_model,
                diarize_threshold: threshold,
                diarize_speakers: speakers,
                download_models: download,
            },
        ),
        IngestCommand::Backfill { folder, yes } => ingest_backfill(&folder, yes, paths),
    }
}

/// Watches every enabled folder and runs the worker until ctrl-c. The worker finishes its
/// current chunk and checkpoints before `shutdown` returns (04-ingest.md).
fn ingest_run(paths: &Paths, pipeline_cfg: PipelineConfig) -> Result<()> {
    paths.ensure()?;
    let database = Database::open(paths.db_file())?;
    let backend = FfmpegCli::discover();
    let store = ModelStore::new(paths.models_dir());
    let cfg = IngestConfig::default();

    let (service, events) =
        IngestService::start(database, paths.clone(), backend, store, cfg, pipeline_cfg, false)?;
    let cancel = service.cancel_handle();
    let _ = ctrlc::set_handler(move || cancel.cancel());

    eprintln!("watching; ctrl-c to stop");
    for event in events {
        match event {
            Event::Discovered { recording_id } => println!("#{recording_id} discovered"),
            Event::Progress { recording_id, stage, pct } => {
                eprint!("\r#{recording_id} {stage} {:>3}%", (pct * 100.0) as i32);
                let _ = std::io::Write::flush(&mut std::io::stderr());
            }
            Event::Done { recording_id } => println!("\n#{recording_id} done"),
            Event::Failed { recording_id, error } => println!("\n#{recording_id} failed: {error}"),
        }
    }
    service.shutdown();
    Ok(())
}

fn ingest_backfill(folder: &Path, yes: bool, paths: &Paths) -> Result<()> {
    paths.ensure()?;
    let folder = folder
        .canonicalize()
        .with_context(|| format!("resolving {}", folder.display()))?;
    let cfg = IngestConfig::default();
    let backend = FfmpegCli::discover();
    let estimate = ingest::backfill::scan(&folder, &cfg, &backend)?;
    println!(
        "{} matching file(s), {:.1}s audio, ~{:.1}s estimated processing",
        estimate.count,
        estimate.total_duration_ms as f64 / 1000.0,
        estimate.estimated_processing_ms as f64 / 1000.0,
    );
    if !yes {
        println!("pass --yes to enqueue");
        return Ok(());
    }
    let database = Database::open(paths.db_file())?;
    {
        let conn = database.connect()?;
        unottr_core::db::watch_folders::add(&conn, &folder)?;
    }
    let ids = ingest::backfill::confirm(&database, &folder, &cfg)?;
    println!("enqueued {} recording(s)", ids.len());
    Ok(())
}

fn db(cmd: DbCommand, paths: &Paths) -> Result<()> {
    match cmd {
        DbCommand::Path => {
            println!("database  {}", paths.db_file().display());
            println!("models    {}", paths.models_dir().display());
            println!("pcm cache {}", paths.pcm_cache_dir().display());
            println!("logs      {}", paths.logs_dir().display());
        }
        DbCommand::Migrate => {
            paths.ensure()?;
            let database = Database::open(paths.db_file())?;
            let conn = database.connect()?;
            println!(
                "migrated {} to schema v{}",
                database.path().display(),
                unottr_core::db::current_version(&conn)?
            );
        }
        DbCommand::Reset { yes } => {
            if !yes {
                anyhow::bail!(
                    "refusing to delete {}; pass --yes",
                    paths.db_file().display()
                );
            }
            for suffix in ["", "-wal", "-shm"] {
                let mut path = paths.db_file().into_os_string();
                path.push(suffix);
                let path = PathBuf::from(path);
                if path.exists() {
                    std::fs::remove_file(&path)
                        .with_context(|| format!("removing {}", path.display()))?;
                }
            }
            println!("database reset");
        }
    }
    Ok(())
}

