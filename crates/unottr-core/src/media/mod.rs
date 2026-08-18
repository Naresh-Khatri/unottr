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

/// Load a whole pcm file as the f32 samples whisper wants. ~230 MB per hour of audio in
/// memory; the alternative is decoding the same bytes once per chunk.
pub fn read_pcm_f32(path: &Path) -> Result<Vec<f32>> {
    use crate::error::IoResultExt;

    let bytes = std::fs::read(path).at(path)?;
    Ok(bytes
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pcm_sizing_round_trips() {
        assert_eq!(pcm_duration_ms(pcm_bytes_for_ms(90_000)), 90_000);
    }

    #[test]
    fn reads_samples_as_normalised_floats() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.pcm");
        // trailing odd byte is dropped rather than misread as half a sample
        let mut raw = Vec::new();
        raw.extend_from_slice(&0i16.to_le_bytes());
        raw.extend_from_slice(&i16::MIN.to_le_bytes());
        raw.push(0x7f);
        std::fs::write(&path, &raw).unwrap();

        assert_eq!(read_pcm_f32(&path).unwrap(), vec![0.0, -1.0]);
    }
}
