//! Local meeting transcription: probe, extract, transcribe, diarize.
//!
//! Deliberately free of any Tauri dependency so the pipeline is testable headless and
//! drivable from the `unottr` CLI.

pub mod cancel;
pub mod db;
pub mod diarize;
pub mod error;
pub mod logging;
pub mod media;
pub mod model;
pub mod paths;
pub mod transcribe;

pub use cancel::CancelToken;
pub use db::Database;
pub use error::{Error, Result};
pub use model::{ModelSpec, ModelStore};
pub use paths::Paths;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
