//! Headless driver for the pipeline. Phases 01-03 are built and validated through this
//! before any UI exists.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use unottr_core::media::{FfmpegCli, MediaBackend, TrackRule};
use unottr_core::transcribe::{self, Device, Job, ModelStore, Options};
use unottr_core::{CancelToken, Database, Paths};

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
    },
    /// Manage the local whisper models
    #[command(subcommand)]
    Models(ModelCommand),
    /// Diarize a file (phase 03)
    Diarize { file: PathBuf },
    /// Run the full pipeline on one file
    Run { file: PathBuf },
    /// Inspect the local database
    #[command(subcommand)]
    Db(DbCommand),
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
        } => transcribe_file(
            &file,
            TranscribeArgs {
                model,
                device: device.into(),
                language,
                threads,
                download,
                print,
            },
            &paths,
        ),
        Command::Diarize { .. } => unimplemented("diarize", 3),
        Command::Run { .. } => unimplemented("run", 4),
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

    let pcm = pcm_for(file, paths, &cancel)?;
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

/// Accepts either a raw pcm or a media file, extracting (once) in the latter case. Phase 04
/// owns this orchestration properly; here it just keeps the cli usable on real recordings.
fn pcm_for(file: &Path, paths: &Paths, cancel: &CancelToken) -> Result<PathBuf> {
    if file.extension().is_some_and(|e| e == "pcm") {
        return Ok(file.to_path_buf());
    }

    let backend = FfmpegCli::discover();
    let probe = backend.probe(file)?;
    let choice = unottr_core::media::select(&probe, &TrackRule::Auto)?;
    let audio_index = match choice.selection {
        unottr_core::media::Selection::Blind { stream } => stream,
        unottr_core::media::Selection::MicDesktop { mic, .. } => mic,
    };

    let out = transcribe::pcm_path_for(&paths.pcm_cache_dir(), file, audio_index);
    if out.exists() {
        return Ok(out);
    }
    backend.extract_pcm(file, audio_index, &out, &percent("extracting"), cancel)?;
    eprintln!();
    Ok(out)
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

fn models(cmd: ModelCommand, paths: &Paths) -> Result<()> {
    paths.ensure()?;
    let store = ModelStore::new(paths.models_dir());

    match cmd {
        ModelCommand::List => {
            let device = transcribe::resolve(Device::Auto);
            let default = transcribe::model::default_for(device.is_gpu());
            for spec in unottr_core::transcribe::MODELS {
                println!(
                    "{:<16} {:>6} MB  {:<12} {}",
                    spec.name,
                    spec.size / 1_000_000,
                    if store.is_present(spec) {
                        "downloaded"
                    } else {
                        "-"
                    },
                    if spec.name == default.name {
                        "(default here)"
                    } else {
                        ""
                    },
                );
            }
        }
        ModelCommand::Get { name } => {
            let spec = transcribe::model::find(&name)
                .with_context(|| format!("unknown model `{name}`"))?;
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

fn unimplemented(name: &str, phase: u8) -> Result<()> {
    anyhow::bail!("`{name}` arrives in phase {phase:02}")
}
