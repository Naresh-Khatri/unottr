//! Attaching speakers to transcript segments. Whisper and the diarizer disagree about where
//! anything starts, so this is overlap arithmetic, not a join. Nothing here loads a model —
//! that is deliberate, it is the part worth testing.

use std::collections::HashMap;
use std::ops::Range;

use serde::{Deserialize, Serialize};

use super::Turn;
use crate::transcribe::engine::Word;

/// Two overlaps this close are a coin flip, so we look for a boundary instead of picking.
const TIE: f64 = 0.20;

/// A segment splits at most this many times: 3 -> 8 pieces. Whisper segments run ~10 s; more
/// than a handful of speaker changes in one of those means the turns are noise, not dialogue.
const MAX_DEPTH: usize = 3;

/// A transcript row as phase 02 left it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Segment {
    pub id: i64,
    pub chunk_idx: i64,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
    pub words: Vec<Word>,
}

/// One segment's worth of speech after attribution. Usually a single piece; more when a
/// speaker changed mid-segment.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Piece {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
    pub words: Vec<Word>,
    /// `None` = no turn overlapped at all. Rendered unattributed; we do not guess.
    pub speaker: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Assigned {
    /// The `segments` row this came from.
    pub id: i64,
    pub chunk_idx: i64,
    pub pieces: Vec<Piece>,
}

impl Assigned {
    pub fn is_split(&self) -> bool {
        self.pieces.len() > 1
    }
}

pub fn assign(segments: &[Segment], turns: &[Turn]) -> Vec<Assigned> {
    segments.iter().map(|s| assign_one(s, turns)).collect()
}

fn assign_one(seg: &Segment, turns: &[Turn]) -> Assigned {
    let mut cuts = Vec::new();
    resolve(seg.start_ms, seg.end_ms, &seg.words, 0, turns, 0, &mut cuts);
    let cuts = coalesce(cuts);

    let pieces = cuts
        .iter()
        .map(|cut| Piece {
            start_ms: cut.start_ms,
            end_ms: cut.end_ms,
            // an unsplit segment keeps whisper's own text; only halves get rebuilt, where
            // joining on spaces is right because `Word::text` is already space-stripped
            text: if cuts.len() == 1 {
                seg.text.clone()
            } else {
                join(&seg.words[cut.words.clone()])
            },
            words: seg.words[cut.words.clone()].to_vec(),
            speaker: cut.speaker,
        })
        .collect();

    Assigned {
        id: seg.id,
        chunk_idx: seg.chunk_idx,
        pieces,
    }
}

/// A half-open slice of a segment's words plus who said it.
#[derive(Debug, Clone)]
struct Cut {
    words: Range<usize>,
    start_ms: u64,
    end_ms: u64,
    speaker: Option<u32>,
}

fn resolve(
    start_ms: u64,
    end_ms: u64,
    words: &[Word],
    base: usize,
    turns: &[Turn],
    depth: usize,
    out: &mut Vec<Cut>,
) {
    let ranked = rank(start_ms, end_ms, turns);
    let span = base..base + words.len();

    let Some(&(top, best)) = ranked.first() else {
        out.push(Cut {
            words: span,
            start_ms,
            end_ms,
            speaker: None,
        });
        return;
    };

    let split = if depth < MAX_DEPTH && words.len() >= 2 {
        ranked
            .get(1)
            .filter(|&&(_, second)| tied(best, second))
            .and_then(|&(other, _)| crossover(start_ms, end_ms, turns, top, other))
            .map(|boundary| snap(words, boundary))
    } else {
        None
    };

    let Some(k) = split else {
        out.push(Cut {
            words: span,
            start_ms,
            end_ms,
            speaker: Some(top),
        });
        return;
    };

    resolve(
        start_ms,
        words[k - 1].end_ms,
        &words[..k],
        base,
        turns,
        depth + 1,
        out,
    );
    resolve(
        words[k].start_ms,
        end_ms,
        &words[k..],
        base + k,
        turns,
        depth + 1,
        out,
    );
}

/// Speakers by how much of `[start_ms, end_ms)` they hold, most first. Summed per *speaker*
/// rather than per turn: two short turns by one person should beat one long turn by another.
fn rank(start_ms: u64, end_ms: u64, turns: &[Turn]) -> Vec<(u32, u64)> {
    let mut totals: HashMap<u32, u64> = HashMap::new();
    for turn in turns {
        let hit = overlap(start_ms, end_ms, turn.start_ms, turn.end_ms);
        if hit > 0 {
            *totals.entry(turn.speaker).or_default() += hit;
        }
    }
    let mut ranked: Vec<(u32, u64)> = totals.into_iter().collect();
    // speaker id breaks ties so the same input always assigns the same way
    ranked.sort_unstable_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    ranked
}

fn overlap(a0: u64, a1: u64, b0: u64, b1: u64) -> u64 {
    a1.min(b1).saturating_sub(a0.max(b0))
}

fn tied(best: u64, second: u64) -> bool {
    best > 0 && (best - second) as f64 / best as f64 <= TIE
}

/// Where `a` most plausibly hands over to `b`. Candidates are turn edges strictly inside the
/// segment; the winner is the one that leaves the most speech on the correct side of it.
fn crossover(start_ms: u64, end_ms: u64, turns: &[Turn], a: u32, b: u32) -> Option<u64> {
    let mut edges: Vec<u64> = turns
        .iter()
        .filter(|t| overlap(start_ms, end_ms, t.start_ms, t.end_ms) > 0)
        .flat_map(|t| [t.start_ms, t.end_ms])
        .filter(|&e| e > start_ms && e < end_ms)
        .collect();
    edges.sort_unstable();
    edges.dedup();

    let held = |lo: u64, hi: u64, who: u32| -> u64 {
        turns
            .iter()
            .filter(|t| t.speaker == who)
            .map(|t| overlap(lo, hi, t.start_ms, t.end_ms))
            .sum()
    };

    edges
        .into_iter()
        .map(|e| {
            let forward = held(start_ms, e, a) + held(e, end_ms, b);
            let reverse = held(start_ms, e, b) + held(e, end_ms, a);
            (e, forward.max(reverse))
        })
        .max_by(|x, y| x.1.cmp(&y.1).then(y.0.cmp(&x.0)))
        .map(|(e, _)| e)
}

/// Nearest word start to `boundary`, as an index into `words`. Never 0 and never
/// `words.len()`, so both halves keep at least one word — the split can only land on a word
/// boundary, which is the whole point.
fn snap(words: &[Word], boundary: u64) -> usize {
    (1..words.len())
        .min_by_key(|&k| words[k].start_ms.abs_diff(boundary))
        .expect("caller checked words.len() >= 2")
}

/// Halves resolved independently can land on the same speaker; that split bought nothing.
fn coalesce(cuts: Vec<Cut>) -> Vec<Cut> {
    let mut out: Vec<Cut> = Vec::with_capacity(cuts.len());
    for cut in cuts {
        match out.last_mut() {
            Some(prev) if prev.speaker == cut.speaker => {
                prev.words.end = cut.words.end;
                prev.end_ms = cut.end_ms;
            }
            _ => out.push(cut),
        }
    }
    out
}

fn join(words: &[Word]) -> String {
    words
        .iter()
        .map(|w| w.text.as_str())
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(start_ms: u64, end_ms: u64, speaker: u32) -> Turn {
        Turn {
            start_ms,
            end_ms,
            speaker,
        }
    }

    /// One word every 500 ms, named for its index, covering `[start, start + 500n)`.
    fn words(start_ms: u64, n: usize) -> Vec<Word> {
        (0..n)
            .map(|i| Word {
                text: format!("w{i}"),
                start_ms: start_ms + i as u64 * 500,
                end_ms: start_ms + i as u64 * 500 + 400,
                p: 1.0,
            })
            .collect()
    }

    fn segment(start_ms: u64, end_ms: u64, n: usize) -> Segment {
        let ws = words(start_ms, n);
        Segment {
            id: 1,
            chunk_idx: 0,
            start_ms,
            end_ms,
            text: join(&ws),
            words: ws,
        }
    }

    #[test]
    fn the_dominant_speaker_takes_the_segment() {
        let seg = segment(0, 10_000, 20);
        let turns = [turn(0, 9_000, 7), turn(9_000, 20_000, 3)];

        let out = assign(&[seg], &turns);
        assert_eq!(out[0].pieces.len(), 1);
        assert_eq!(out[0].pieces[0].speaker, Some(7));
    }

    #[test]
    fn an_unsplit_segment_keeps_whisper_text_verbatim() {
        let mut seg = segment(0, 10_000, 4);
        seg.text = "Hello, there -- fine?".into();
        let out = assign(&[seg], &[turn(0, 10_000, 1)]);
        assert_eq!(out[0].pieces[0].text, "Hello, there -- fine?");
    }

    #[test]
    fn no_overlapping_turn_leaves_the_speaker_unknown() {
        let out = assign(&[segment(60_000, 65_000, 4)], &[turn(0, 5_000, 1)]);
        assert_eq!(out[0].pieces[0].speaker, None);
        assert!(!out[0].is_split());
    }

    #[test]
    fn no_turns_at_all_leaves_every_segment_unknown() {
        let out = assign(&[segment(0, 5_000, 4), segment(5_000, 9_000, 3)], &[]);
        assert!(out.iter().all(|a| a.pieces[0].speaker.is_none()));
    }

    #[test]
    fn a_speaker_change_mid_segment_splits_it() {
        // 10 s, 20 words; speaker 1 owns the first half, speaker 2 the second
        let seg = segment(0, 10_000, 20);
        let turns = [turn(0, 5_000, 1), turn(5_000, 10_000, 2)];

        let out = assign(&[seg], &turns);
        assert_eq!(out[0].pieces.len(), 2, "{:?}", out[0].pieces);
        assert_eq!(out[0].pieces[0].speaker, Some(1));
        assert_eq!(out[0].pieces[1].speaker, Some(2));
        assert_eq!(out[0].pieces[0].text, "w0 w1 w2 w3 w4 w5 w6 w7 w8 w9");
        assert_eq!(
            out[0].pieces[1].text,
            "w10 w11 w12 w13 w14 w15 w16 w17 w18 w19"
        );
    }

    #[test]
    fn a_split_only_ever_lands_on_a_word_boundary() {
        let seg = segment(0, 10_000, 20);
        // boundary at 5_200 falls *inside* word 10 (5_000..5_400); the split must not
        let turns = [turn(0, 5_200, 1), turn(5_200, 10_000, 2)];

        let out = assign(std::slice::from_ref(&seg), &turns);
        let pieces = &out[0].pieces;
        assert!(out[0].is_split());

        let starts: Vec<u64> = seg.words.iter().map(|w| w.start_ms).collect();
        let ends: Vec<u64> = seg.words.iter().map(|w| w.end_ms).collect();
        // the outer edges stay whisper's; every seam between pieces is a word boundary
        assert_eq!(pieces[0].start_ms, seg.start_ms);
        assert_eq!(pieces.last().unwrap().end_ms, seg.end_ms);
        for pair in pieces.windows(2) {
            assert!(ends.contains(&pair[0].end_ms), "{:?}", pair[0]);
            assert!(starts.contains(&pair[1].start_ms), "{:?}", pair[1]);
        }
        assert!(pieces.iter().all(|p| !p.words.is_empty()));
        // 5_200 sits inside w10 (5_000..5_400); the seam snapped to its start, not through it
        assert_eq!(pieces[1].start_ms, 5_000);
    }

    #[test]
    fn split_pieces_cover_every_word_exactly_once() {
        let seg = segment(0, 30_000, 60);
        let turns = [
            turn(0, 10_000, 1),
            turn(10_000, 20_000, 2),
            turn(20_000, 30_000, 3),
        ];

        let out = assign(std::slice::from_ref(&seg), &turns);
        let rebuilt: Vec<&str> = out[0]
            .pieces
            .iter()
            .flat_map(|p| p.words.iter().map(|w| w.text.as_str()))
            .collect();
        let original: Vec<&str> = seg.words.iter().map(|w| w.text.as_str()).collect();
        assert_eq!(rebuilt, original);
    }

    #[test]
    fn three_speakers_in_one_segment_all_get_a_piece() {
        let seg = segment(0, 30_000, 60);
        let turns = [
            turn(0, 10_000, 1),
            turn(10_000, 20_000, 2),
            turn(20_000, 30_000, 3),
        ];

        let out = assign(&[seg], &turns);
        let spoke: Vec<Option<u32>> = out[0].pieces.iter().map(|p| p.speaker).collect();
        assert_eq!(spoke, [Some(1), Some(2), Some(3)]);
    }

    #[test]
    fn a_lopsided_overlap_is_not_a_tie_and_does_not_split() {
        // 70/30 is well outside the 20% band even with a boundary sitting inside
        let seg = segment(0, 10_000, 20);
        let turns = [turn(0, 7_000, 1), turn(7_000, 10_000, 2)];
        assert!(!assign(&[seg], &turns)[0].is_split());
    }

    #[test]
    fn two_turns_by_one_speaker_never_split_the_segment() {
        let seg = segment(0, 10_000, 20);
        let turns = [turn(0, 4_900, 1), turn(5_100, 10_000, 1)];

        let out = assign(&[seg], &turns);
        assert_eq!(out[0].pieces.len(), 1);
        assert_eq!(out[0].pieces[0].speaker, Some(1));
    }

    #[test]
    fn a_single_word_segment_cannot_split() {
        let seg = segment(0, 10_000, 1);
        let turns = [turn(0, 5_000, 1), turn(5_000, 10_000, 2)];
        assert_eq!(assign(&[seg], &turns)[0].pieces.len(), 1);
    }

    #[test]
    fn a_segment_with_no_words_cannot_split() {
        let mut seg = segment(0, 10_000, 20);
        seg.words.clear();
        let turns = [turn(0, 5_000, 1), turn(5_000, 10_000, 2)];

        let out = assign(&[seg], &turns);
        assert_eq!(out[0].pieces.len(), 1);
        assert!(out[0].pieces[0].speaker.is_some());
    }

    #[test]
    fn splitting_is_bounded() {
        // alternating 1 s turns: without the depth guard this would shred the segment
        let seg = segment(0, 30_000, 60);
        let turns: Vec<Turn> = (0..30)
            .map(|i| turn(i * 1_000, (i + 1) * 1_000, (i % 2) as u32))
            .collect();

        let out = assign(&[seg], &turns);
        assert!(out[0].pieces.len() <= 8, "{}", out[0].pieces.len());
    }

    #[test]
    fn assignment_is_deterministic() {
        let seg = segment(0, 10_000, 20);
        let turns = [turn(0, 5_000, 2), turn(5_000, 10_000, 1)];

        let a = assign(std::slice::from_ref(&seg), &turns);
        let b = assign(&[seg], &turns);
        let spk = |v: &[Assigned]| -> Vec<Option<u32>> {
            v[0].pieces.iter().map(|p| p.speaker).collect()
        };
        assert_eq!(spk(&a), spk(&b));
    }

    #[test]
    fn overlap_is_zero_when_spans_only_touch() {
        assert_eq!(overlap(0, 100, 100, 200), 0);
        assert_eq!(overlap(0, 100, 50, 200), 50);
        assert_eq!(overlap(0, 100, 200, 300), 0);
    }

    #[test]
    fn the_tie_band_is_twenty_percent() {
        assert!(tied(1000, 800));
        assert!(!tied(1000, 799));
        assert!(!tied(1000, 0));
    }
}
