use std::time::Duration;

/// Broad by default (04-ingest.md); folders can narrow it later via settings if that ever
/// becomes configurable per-folder.
pub const DEFAULT_EXTENSIONS: &[&str] = &[
    "mkv", "mp4", "mov", "webm", "m4a", "mp3", "wav", "flac", "ogg", "opus", "avi", "ts", "flv",
];

/// Tunables for the watcher and worker. Kept out of `IngestService::start`'s signature as a
/// single struct so tests can shrink the timing without touching call sites.
#[derive(Debug, Clone)]
pub struct IngestConfig {
    pub extensions: Vec<String>,
    /// How often a tracked candidate's size is re-checked.
    pub stable_poll_interval: Duration,
    /// Consecutive identical-size polls required before a candidate is considered finished
    /// writing (04-ingest.md: 2s x 5 = ~10s).
    pub stable_required_count: u32,
    /// Once size is stable, ffprobe is retried up to this many ticks before the file is
    /// queued anyway — a genuinely corrupt file must still reach `Probing` and fail visibly,
    /// not sit in watcher limbo forever.
    pub max_probe_checks: u32,
    /// Safety-net full rescan cadence, for filesystems that don't deliver inotify events and
    /// for noticing a watched folder was deleted and recreated.
    pub rescan_interval: Duration,
    /// Total attempts (1 initial + N retries) before a job parks in `Failed`.
    pub max_attempts: i64,
    /// Wall-clock seconds spent per second of audio, for the backfill estimate. Tunable via
    /// the `settings` table once real numbers accumulate; this is a conservative cpu default.
    pub realtime_factor: f64,
}

impl Default for IngestConfig {
    fn default() -> Self {
        Self {
            extensions: DEFAULT_EXTENSIONS.iter().map(|s| s.to_string()).collect(),
            stable_poll_interval: Duration::from_secs(2),
            stable_required_count: 5,
            max_probe_checks: 5,
            rescan_interval: Duration::from_secs(30),
            max_attempts: 3,
            realtime_factor: 0.6,
        }
    }
}

impl IngestConfig {
    pub fn has_extension(&self, path: &std::path::Path) -> bool {
        path.extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| self.extensions.iter().any(|x| x.eq_ignore_ascii_case(e)))
    }
}
