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
