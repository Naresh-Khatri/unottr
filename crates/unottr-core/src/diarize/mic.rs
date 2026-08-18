//! The two-track shortcut. When phase 01 identified a mic track, the local user is not a
//! clustering problem: everything on that track is them. Speech detection is enough, and it
//! is both faster and more reliable than asking an embedder to tell one voice from another
//! through Meet's noise suppression.

use std::path::Path;

use tracing::info;

use super::{Diarization, Turn};
use crate::error::Result;
use crate::transcribe::chunk::{Span, detect_speech};

/// The local user always takes id 0 in the merged label space.
pub const YOU: u32 = 0;
pub const YOU_LABEL: &str = "You";

/// Pauses shorter than this are inside a sentence, not between turns.
const MERGE_GAP_MS: u64 = 800;

/// A cough or a keystroke trips the vad; a turn does not last 300 ms.
const MIN_TURN_MS: u64 = 400;

/// Speech on the mic track, as turns belonging to [`YOU`].
pub fn detect(mic_pcm: &[f32], vad_model: &Path) -> Result<Vec<Turn>> {
    let spans = detect_speech(mic_pcm, vad_model)?;
    let turns = turns_from(&spans);
    info!(spans = spans.len(), turns = turns.len(), "mic track");
    Ok(turns)
}

fn turns_from(spans: &[Span]) -> Vec<Turn> {
    let mut out: Vec<Turn> = Vec::new();
    for span in spans {
        match out.last_mut() {
            Some(prev) if span.start_ms.saturating_sub(prev.end_ms) <= MERGE_GAP_MS => {
                prev.end_ms = prev.end_ms.max(span.end_ms);
            }
            _ => out.push(Turn {
                start_ms: span.start_ms,
                end_ms: span.end_ms,
                speaker: YOU,
            }),
        }
    }
    out.retain(|t| t.end_ms - t.start_ms >= MIN_TURN_MS);
    out
}

/// Fold the desktop track's speakers in above the local user. Ids shift by one, so the
/// merged space reads 0 = You, 1..N = the people on the call.
pub fn combine(you: Vec<Turn>, you_embedding: Vec<f32>, desktop: Diarization) -> Diarization {
    let mut turns = you;
    turns.extend(desktop.turns.into_iter().map(|t| Turn {
        speaker: t.speaker + 1,
        ..t
    }));
    turns.sort_unstable_by_key(|t| (t.start_ms, t.end_ms, t.speaker));

    let mut embeddings = vec![you_embedding];
    embeddings.extend(desktop.embeddings);
    Diarization { turns, embeddings }
}

/// `Speaker 1` is the first remote voice; the local user is never numbered.
pub fn label(speaker: u32) -> String {
    if speaker == YOU {
        YOU_LABEL.to_string()
    } else {
        format!("Speaker {speaker}")
    }
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
    fn a_short_pause_does_not_end_a_turn() {
        let turns = turns_from(&spans(&[(0, 2_000), (2_500, 4_000)]));
        assert_eq!(turns.len(), 1);
        assert_eq!((turns[0].start_ms, turns[0].end_ms), (0, 4_000));
    }

    #[test]
    fn a_long_pause_ends_a_turn() {
        let turns = turns_from(&spans(&[(0, 2_000), (10_000, 12_000)]));
        assert_eq!(turns.len(), 2);
    }

    #[test]
    fn vad_blips_are_dropped() {
        assert!(turns_from(&spans(&[(0, 200)])).is_empty());
    }

    #[test]
    fn every_mic_turn_is_the_local_user() {
        let turns = turns_from(&spans(&[(0, 2_000), (10_000, 12_000)]));
        assert!(turns.iter().all(|t| t.speaker == YOU));
    }

    #[test]
    fn combining_shifts_desktop_speakers_above_you() {
        let you = turns_from(&spans(&[(0, 2_000)]));
        let desktop = Diarization {
            turns: vec![
                Turn {
                    start_ms: 3_000,
                    end_ms: 5_000,
                    speaker: 0,
                },
                Turn {
                    start_ms: 5_000,
                    end_ms: 6_000,
                    speaker: 1,
                },
            ],
            embeddings: vec![vec![0.1; 4], vec![0.2; 4]],
        };

        let out = combine(you, vec![0.9; 4], desktop);
        assert_eq!(
            out.turns.iter().map(|t| t.speaker).collect::<Vec<_>>(),
            [YOU, 1, 2]
        );
        assert_eq!(out.embeddings.len(), 3);
        assert_eq!(out.embeddings[0], vec![0.9; 4], "you comes first");
    }

    #[test]
    fn labels_read_the_way_a_transcript_should() {
        assert_eq!(label(0), "You");
        assert_eq!(label(1), "Speaker 1");
        assert_eq!(label(2), "Speaker 2");
    }
}
