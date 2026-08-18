//! Local meeting transcription: probe, extract, transcribe, diarize.
//!
//! Deliberately free of any Tauri dependency so the pipeline is testable headless and
//! drivable from the `unottr` CLI.

pub mod db;
pub mod error;
pub mod logging;
pub mod paths;

pub use db::Database;
pub use error::{Error, Result};
pub use paths::Paths;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
