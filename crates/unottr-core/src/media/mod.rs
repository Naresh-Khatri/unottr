//! Turning a user's arbitrary media file into pcm the pipeline can read.

mod ffmpeg;
mod track;

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::cancel::CancelToken;
use crate::error::Result;

pub use ffmpeg::FfmpegCli;
pub use track::{Selection, TrackChoice, TrackRule, select};

/// Sample rate whisper.cpp expects. Everything downstream assumes mono s16le at this rate.
pub const TARGET_SAMPLE_RATE: u32 = 16_000;

/// The single seam between the pipeline and whatever decodes media. Phase 07 swaps a
/// bundled ffmpeg in behind this without touching a call site.
pub trait MediaBackend: Send + Sync {
    fn probe(&self, path: &Path) -> Result<Probe>;

    /// Decodes one audio track to 16 kHz mono s16le. `audio_index` is the position among
    /// audio streams, not the global stream index.
    fn extract_pcm(
        &self,
        path: &Path,
        audio_index: u32,
        out: &Path,
        progress: &dyn Fn(f32),
        cancel: &CancelToken,
    ) -> Result<()>;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Probe {
    pub container: String,
    pub duration_ms: Option<u64>,
    pub has_video: bool,
    pub audio: Vec<AudioStream>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioStream {
    /// Global stream index, for display.
    pub index: u32,
    /// Position among audio streams; this is what `-map 0:a:N` takes.
    pub audio_index: u32,
    pub codec: String,
    pub channels: u16,
    pub sample_rate: u32,
    pub title: Option<String>,
    pub language: Option<String>,
}

impl Probe {
    pub fn stream(&self, audio_index: u32) -> Option<&AudioStream> {
        self.audio.iter().find(|s| s.audio_index == audio_index)
    }
}

/// Bytes of 16 kHz mono s16le pcm for a given duration.
pub fn pcm_bytes_for_ms(duration_ms: u64) -> u64 {
    duration_ms * u64::from(TARGET_SAMPLE_RATE) * 2 / 1000
}

/// Duration represented by a pcm file of this size.
pub fn pcm_duration_ms(bytes: u64) -> u64 {
    bytes * 1000 / (u64::from(TARGET_SAMPLE_RATE) * 2)
}
