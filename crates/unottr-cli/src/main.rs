//! Headless driver for the pipeline. Phases 01-03 are built and validated through this
//! before any UI exists.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use unottr_core::media::{FfmpegCli, MediaBackend, TrackRule};
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
    /// Transcribe a file (phase 02)
    Transcribe { file: PathBuf },
    /// Diarize a file (phase 03)
    Diarize { file: PathBuf },
    /// Run the full pipeline on one file
    Run { file: PathBuf },
    /// Inspect the local database
    #[command(subcommand)]
    Db(DbCommand),
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
        Command::Transcribe { .. } => unimplemented("transcribe", 2),
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

    let last = std::cell::Cell::new(-1i32);
    let progress = |fraction: f32| {
        let percent = (fraction * 100.0) as i32;
        if percent > last.replace(percent) {
            eprint!("\rextracting {percent:3}%");
            let _ = std::io::Write::flush(&mut std::io::stderr());
        }
    };
    backend.extract_pcm(file, audio_index, &out, &progress, &cancel)?;
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
