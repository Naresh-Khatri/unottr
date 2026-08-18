use std::path::PathBuf;

pub type Result<T> = std::result::Result<T, Error>;

/// Every failure the pipeline can produce. Variants stay distinguishable because phase 07
/// maps each one to a user-facing message and a retry policy.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("io error at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),

    #[error("ffmpeg was not found")]
    FfmpegMissing,

    #[error("ffmpeg failed: {0}")]
    Ffmpeg(String),

    #[error("could not probe {path}: {reason}")]
    Probe { path: PathBuf, reason: String },

    #[error("{path} has no audio track")]
    NoAudio { path: PathBuf },

    #[error("{path} is incomplete or corrupt")]
    Truncated { path: PathBuf },

    #[error("transcription failed: {0}")]
    Whisper(String),

    #[error("gpu ran out of memory")]
    GpuOom,

    #[error("diarization failed: {0}")]
    Diarize(String),

    #[error("model {name} is not downloaded")]
    ModelMissing { name: String },

    #[error("could not download {name}: {reason}")]
    Download { name: String, reason: String },

    #[error("cancelled")]
    Cancelled,

    #[error("could not resolve the {0} directory for this platform")]
    NoBaseDir(&'static str),
}

impl Error {
    /// Short typed-error slug for the UI (05-ipc-contract.md: `job_failed { error: string }`).
    /// Stable across variant field changes — never derive this from `{0}`/`Display`.
    pub fn slug(&self) -> &'static str {
        match self {
            Error::Io { .. } => "io_error",
            Error::Db(_) => "db_error",
            Error::FfmpegMissing => "ffmpeg_missing",
            Error::Ffmpeg(_) => "ffmpeg_failed",
            Error::Probe { .. } => "probe_failed",
            Error::NoAudio { .. } => "no_audio",
            Error::Truncated { .. } => "truncated",
            Error::Whisper(_) => "whisper_failed",
            Error::GpuOom => "gpu_oom",
            Error::Diarize(_) => "diarize_failed",
            Error::ModelMissing { .. } => "model_missing",
            Error::Download { .. } => "download_failed",
            Error::Cancelled => "cancelled",
            Error::NoBaseDir(_) => "no_base_dir",
        }
    }

    /// What the worker should do about this failure (07-hardening-and-packaging.md's failure
    /// taxonomy table). `max_attempts` only matters for `Bounded` — the file-is-the-problem
    /// and fix-then-retry cases park after a single failure regardless of it.
    pub fn retry_policy(&self, max_attempts: i64) -> RetryPolicy {
        match self {
            // the file itself is the problem; no amount of retrying fixes it
            Error::NoAudio { .. } | Error::Truncated { .. } => RetryPolicy::Terminal,
            // parked until the user fixes the cause (installs ffmpeg, downloads the model),
            // then the existing "Retry" path (`reset_for_retry`) requeues it
            Error::FfmpegMissing | Error::ModelMissing { .. } => RetryPolicy::OnFix,
            // GpuOom is handled specially by the worker (force-cpu-and-retry-once) before it
            // ever reaches `fail_or_retry`; this arm only fires if it somehow still does.
            _ => RetryPolicy::Bounded(max_attempts),
        }
    }
}

/// Whether/how a failed job gets retried. Distinct from `slug`, which only names the error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetryPolicy {
    /// Never retry, not even manually — table says "none, terminal".
    Terminal,
    /// Parks after one failure; retryable once the user acts (install/download + Retry).
    OnFix,
    /// Automatic retries up to `n` total attempts, then parks.
    Bounded(i64),
}

/// Attaches the offending path to io errors, which std does not carry.
pub trait IoResultExt<T> {
    fn at(self, path: impl Into<PathBuf>) -> Result<T>;
}

impl<T> IoResultExt<T> for std::io::Result<T> {
    fn at(self, path: impl Into<PathBuf>) -> Result<T> {
        self.map_err(|source| Error::Io {
            path: path.into(),
            source,
        })
    }
}
