use std::path::Path;

use serde::{Deserialize, Serialize};
use tracing::debug;
use whisper_rs::{WhisperVadContext, WhisperVadContextParams, WhisperVadParams};

use crate::error::{Error, Result};
use crate::media::TARGET_SAMPLE_RATE;

/// Whisper's encoder window. A chunk longer than this gets truncated inside whisper.cpp.
pub const MAX_CHUNK_MS: u64 = 30_000;

/// Silence longer than this ends a chunk even when there is room left. Keeps dead air out
/// of the audio we hand whisper, which is the mitigation for hallucinated filler.
pub const MAX_GAP_MS: u64 = 2_000;

/// A run of speech as the VAD sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Span {
    pub start_ms: u64,
    pub end_ms: u64,
}

/// One unit of transcription and one DB transaction. `idx` is what lands in
/// `segments.chunk_idx` and `recordings.last_chunk_idx`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Chunk {
    pub idx: usize,
    pub start_ms: u64,
    pub end_ms: u64,
}

impl Chunk {
    pub fn duration_ms(&self) -> u64 {
        self.end_ms - self.start_ms
    }

    /// Sample range into the whole-file pcm buffer.
    pub fn range(&self, total_samples: usize) -> std::ops::Range<usize> {
        let lo = samples_at(self.start_ms).min(total_samples);
        let hi = samples_at(self.end_ms).min(total_samples).max(lo);
        lo..hi
    }
}

fn samples_at(ms: u64) -> usize {
    (ms * TARGET_SAMPLE_RATE as u64 / 1000) as usize
}

/// Run Silero over the whole file. Kept separate from `pack` so the packing rules stay
/// unit-testable without a model on disk.
///
/// Always cpu: the silero graph aborts on the vulkan backend ("pre-allocated tensor in a
/// buffer that cannot run the operation"). It is <1 MB and runs in about a second anyway.
pub fn detect_speech(samples: &[f32], vad_model: &Path) -> Result<Vec<Span>> {
    let path = vad_model.to_str().ok_or_else(|| Error::ModelMissing {
        name: vad_model.display().to_string(),
    })?;

    let mut ctx_params = WhisperVadContextParams::new();
    ctx_params.set_use_gpu(false);
    let mut ctx =
        WhisperVadContext::new(path, ctx_params).map_err(|e| Error::Whisper(e.to_string()))?;

    let mut params = WhisperVadParams::new();
    // makes the vad itself break up a monologue, so `pack` rarely has to hard-split
    params.set_max_speech_duration(MAX_CHUNK_MS as f32 / 1000.0);

    let segments = ctx
        .segments_from_samples(params, samples)
        .map_err(|e| Error::Whisper(e.to_string()))?;

    // whisper's vad timestamps are centiseconds
    let spans: Vec<Span> = segments
        .map(|s| Span {
            start_ms: (s.start.max(0.0) * 10.0) as u64,
            end_ms: (s.end.max(0.0) * 10.0) as u64,
        })
        .filter(|s| s.end_ms > s.start_ms)
        .collect();

    debug!(spans = spans.len(), "vad done");
    Ok(spans)
}

/// Greedily merge speech spans into chunks. Deterministic, so a resumed run reproduces
/// identical boundaries and `last_chunk_idx` still means what it meant.
pub fn pack(spans: &[Span], max_ms: u64, max_gap_ms: u64) -> Vec<Chunk> {
    let mut chunks: Vec<Chunk> = Vec::new();
    let mut open: Option<Chunk> = None;

    for span in spans {
        // vad shouldn't emit these, but a hard split keeps the invariant either way
        for piece in split(*span, max_ms) {
            match open {
                Some(cur)
                    if piece.start_ms.saturating_sub(cur.end_ms) <= max_gap_ms
                        && piece.end_ms - cur.start_ms <= max_ms =>
                {
                    open = Some(Chunk {
                        end_ms: piece.end_ms,
                        ..cur
                    });
                }
                Some(cur) => {
                    chunks.push(cur);
                    open = Some(Chunk {
                        idx: chunks.len(),
                        start_ms: piece.start_ms,
                        end_ms: piece.end_ms,
                    });
                }
                None => {
                    open = Some(Chunk {
                        idx: 0,
                        start_ms: piece.start_ms,
                        end_ms: piece.end_ms,
                    });
                }
            }
        }
    }

    chunks.extend(open);
    chunks
}

fn split(span: Span, max_ms: u64) -> Vec<Span> {
    let mut out = Vec::new();
    let mut start = span.start_ms;
    while span.end_ms - start > max_ms {
        out.push(Span {
            start_ms: start,
            end_ms: start + max_ms,
        });
        start += max_ms;
    }
    out.push(Span {
        start_ms: start,
        end_ms: span.end_ms,
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spans(pairs: &[(u64, u64)]) -> Vec<Span> {
        pairs
            .iter()
            .map(|&(start_ms, end_ms)| Span { start_ms, end_ms })
            .collect()
    }

    #[test]
    fn silence_only_produces_no_chunks() {
        assert!(pack(&[], MAX_CHUNK_MS, MAX_GAP_MS).is_empty());
    }

    #[test]
    fn adjacent_speech_merges_into_one_chunk() {
        let out = pack(
            &spans(&[(0, 5_000), (5_400, 9_000)]),
            MAX_CHUNK_MS,
            MAX_GAP_MS,
        );
        assert_eq!(
            out,
            vec![Chunk {
                idx: 0,
                start_ms: 0,
                end_ms: 9_000
            }]
        );
    }

    #[test]
    fn a_long_gap_starts_a_new_chunk() {
        let out = pack(
            &spans(&[(0, 5_000), (20_000, 22_000)]),
            MAX_CHUNK_MS,
            MAX_GAP_MS,
        );
        assert_eq!(out.len(), 2, "{out:?}");
        assert_eq!(out[1].start_ms, 20_000);
    }

    #[test]
    fn dead_air_never_lands_inside_a_chunk() {
        let out = pack(
            &spans(&[(0, 1_000), (60_000, 61_000)]),
            MAX_CHUNK_MS,
            MAX_GAP_MS,
        );
        let covered: u64 = out.iter().map(Chunk::duration_ms).sum();
        assert_eq!(covered, 2_000);
    }

    #[test]
    fn chunks_never_exceed_the_window() {
        let out = pack(&spans(&[(0, 95_000)]), MAX_CHUNK_MS, MAX_GAP_MS);
        assert!(
            out.iter().all(|c| c.duration_ms() <= MAX_CHUNK_MS),
            "{out:?}"
        );
        assert_eq!(out.last().unwrap().end_ms, 95_000);
    }

    #[test]
    fn indices_are_dense_and_ordered() {
        let out = pack(
            &spans(&[(0, 40_000), (50_000, 55_000), (90_000, 91_000)]),
            MAX_CHUNK_MS,
            MAX_GAP_MS,
        );
        for (i, c) in out.iter().enumerate() {
            assert_eq!(c.idx, i);
            assert!(c.end_ms > c.start_ms);
        }
    }

    #[test]
    fn packing_is_deterministic() {
        let s = spans(&[(0, 12_000), (12_500, 40_000), (70_000, 71_000)]);
        assert_eq!(
            pack(&s, MAX_CHUNK_MS, MAX_GAP_MS),
            pack(&s, MAX_CHUNK_MS, MAX_GAP_MS)
        );
    }

    #[test]
    fn sample_ranges_stay_inside_the_buffer() {
        let c = Chunk {
            idx: 0,
            start_ms: 1_000,
            end_ms: 9_000,
        };
        let r = c.range(16_000 * 4);
        assert_eq!(r.start, 16_000);
        assert_eq!(r.end, 16_000 * 4, "clamped to what we actually have");
    }
}
