//! Phase 08.0 oracle. Writes the pipeline's intermediates — the ones nothing persists — so
//! the TypeScript port has something to be checked against. Deleted with this crate.

use std::path::Path;

use serde::Serialize;
use tracing::{info, warn};

/// Best-effort: a fixture that fails to write must never fail the run it is observing.
pub fn write(dir: &Path, name: &str, value: &impl Serialize) {
    let path = dir.join(name);
    let result = std::fs::create_dir_all(dir)
        .map_err(|e| e.to_string())
        .and_then(|_| serde_json::to_vec_pretty(value).map_err(|e| e.to_string()))
        .and_then(|mut bytes| {
            bytes.push(b'\n');
            std::fs::write(&path, bytes).map_err(|e| e.to_string())
        });
    match result {
        Ok(()) => info!(path = %path.display(), "dumped"),
        Err(e) => warn!(path = %path.display(), error = %e, "dump failed"),
    }
}
