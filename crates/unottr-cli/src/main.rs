//! Headless driver for the pipeline. Phases 01-03 are built and validated through this
//! before any UI exists.

use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use unottr_core::{Database, Paths};

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
    Probe { file: PathBuf },
    /// Extract 16 kHz mono pcm (phase 01)
    Extract {
        file: PathBuf,
        #[arg(long)]
        out: Option<PathBuf>,
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
        Command::Probe { .. } => unimplemented("probe", 1),
        Command::Extract { .. } => unimplemented("extract", 1),
        Command::Transcribe { .. } => unimplemented("transcribe", 2),
        Command::Diarize { .. } => unimplemented("diarize", 3),
        Command::Run { .. } => unimplemented("run", 4),
    }
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
