use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{EnvFilter, fmt, prelude::*};

use crate::error::{IoResultExt, Result};
use crate::paths::Paths;

/// Logs to a daily-rotated file and to stderr. Hold the returned guard for the life of the
/// process; dropping it discards buffered lines.
pub fn init(paths: &Paths) -> Result<WorkerGuard> {
    let dir = paths.logs_dir();
    std::fs::create_dir_all(&dir).at(&dir)?;

    let (writer, guard) =
        tracing_appender::non_blocking(tracing_appender::rolling::daily(&dir, "unottr.log"));

    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,unottr_core=debug"));

    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_writer(writer).with_ansi(false))
        .with(fmt::layer().with_writer(std::io::stderr))
        .init();

    Ok(guard)
}
