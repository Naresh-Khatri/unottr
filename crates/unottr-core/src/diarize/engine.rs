//! The sherpa-onnx side: pyannote segmentation into turns, CAM++ embeddings into clusters.
//!
//! Runs over the whole recording in one pass. Clustering is global — chunking it would let
//! the same voice land in different clusters either side of a boundary, which is the one
//! mistake diarization cannot recover from.

use std::path::Path;
use std::sync::mpsc;

use serde::{Deserialize, Serialize};
use sherpa_rs::diarize::{Diarize, DiarizeConfig};
use sherpa_rs::speaker_id::{EmbeddingExtractor, ExtractorConfig};
use tracing::{debug, info, warn};

use super::{Diarization, Turn};
use crate::cancel::CancelToken;
use crate::error::{Error, Result};
use crate::media::TARGET_SAMPLE_RATE;

/// Cosine distance at which two of sherpa's fragments stop being the same person, when the
/// speaker count is unknown. Smaller -> more speakers. This is our own average-linkage cut
/// over fragment centroids, not sherpa's; see `run`.
pub const DEFAULT_THRESHOLD: f32 = 0.6;

/// Threshold handed to sherpa itself. Deliberately tight: its complete-linkage merges only
/// when every turn-pair agrees, so a tight cut yields many *pure* fragments of each speaker
/// that our own average-linkage then rejoins. A single noisy turn can split a fragment but
/// never contaminate one.
const FRAGMENT_THRESHOLD: f32 = 0.5;

/// Turns shorter than this are dropped; gaps shorter than this do not break a turn. Both
/// are pyannote's own defaults, in seconds.
const MIN_DURATION_ON: f32 = 0.3;
const MIN_DURATION_OFF: f32 = 0.5;

/// Sherpa reports progress over the embedding loop, which is nearly all of the wall clock.
/// The rest is our own centroid pass.
const SEGMENT_SHARE: f32 = 0.9;

/// Turns used to build one speaker's centroid, longest first. Averaging every turn costs
/// minutes on a long meeting and moves the centroid by almost nothing.
const CENTROID_TURNS: usize = 8;

/// The extractor refuses anything shorter than about half a second, and hard-exits the
/// process from inside C++ if it is handed one anyway. Filter well clear of the edge.
const MIN_EMBED_MS: u64 = 800;

/// Past this a turn contributes nothing new to its own embedding.
const MAX_EMBED_MS: u64 = 10_000;

/// A cluster with less total speech than this is a mis-embedded fragment -- a stray "yeah"
/// whose noisy centroid never merged -- not a person. Its turns fold into the nearest real
/// speaker. Tuned to the gap on the corpus: real speakers clear it by 2x+, phantoms sit
/// under 6 s. Only applied in threshold mode; fixed-k trusts the caller's count.
const MIN_SPEAKER_MS: u64 = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Config {
    /// Ignored when `speakers` is set.
    pub threshold: f32,
    /// Known speaker count. `None` clusters on `threshold`, which is the normal case — we
    /// do not know how many people were in a meeting.
    pub speakers: Option<u32>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            threshold: DEFAULT_THRESHOLD,
            speakers: None,
        }
    }
}

#[derive(Debug)]
pub struct Diarizer {
    inner: Diarize,
    embed: EmbeddingExtractor,
    config: Config,
}

impl Diarizer {
    pub fn load(segmentation: &Path, embedding: &Path, config: Config) -> Result<Self> {
        for path in [segmentation, embedding] {
            if !path.exists() {
                return Err(Error::ModelMissing {
                    name: file_name(path),
                });
            }
        }

        let inner = Diarize::new(
            segmentation,
            embedding,
            DiarizeConfig {
                // < 1 is what switches sherpa's clustering from fixed-k to threshold mode;
                // its own `None` means 4, which would invent or merge speakers silently
                num_clusters: Some(config.speakers.map_or(-1, |n| n.max(1) as i32)),
                threshold: Some(FRAGMENT_THRESHOLD),
                min_duration_on: Some(MIN_DURATION_ON),
                min_duration_off: Some(MIN_DURATION_OFF),
                provider: None,
                debug: false,
            },
        )
        .map_err(|e| Error::Diarize(e.to_string()))?;

        let embed = EmbeddingExtractor::new(ExtractorConfig {
            model: embedding.to_string_lossy().into_owned(),
            provider: None,
            num_threads: Some(threads()),
            debug: false,
        })
        .map_err(|e| Error::Diarize(e.to_string()))?;

        info!(?config, dim = embed.embedding_size, "diarizer loaded");
        Ok(Self {
            inner,
            embed,
            config,
        })
    }

    pub fn embedding_size(&self) -> usize {
        self.embed.embedding_size
    }

    /// Diarize a whole recording. `pcm` is 16 kHz mono, the same buffer transcription ran on.
    pub fn run(
        &mut self,
        pcm: &[f32],
        progress: &dyn Fn(f32),
        cancel: &CancelToken,
    ) -> Result<Diarization> {
        cancel.check()?;
        if pcm.is_empty() {
            return Ok(Diarization::default());
        }

        let segments = self.segment(pcm, progress)?;
        cancel.check()?;

        let mut turns = relabel(segments);
        // fixed-k: sherpa's own clustering is trustworthy when it knows the count. Unknown
        // count is where its complete-linkage shatters a speaker, so re-cluster its fragments.
        if self.config.speakers.is_none() {
            self.recluster(pcm, &mut turns, cancel)?;
        }
        let speakers = turns.iter().map(|t| t.speaker + 1).max().unwrap_or(0) as usize;
        info!(turns = turns.len(), speakers, "diarization done");

        let mut embeddings = Vec::with_capacity(speakers);
        for speaker in 0..speakers as u32 {
            cancel.check()?;
            embeddings.push(self.centroid(pcm, &turns, speaker)?);
            progress(
                SEGMENT_SHARE + (1.0 - SEGMENT_SHARE) * (speaker + 1) as f32 / speakers as f32,
            );
        }

        Ok(Diarization { turns, embeddings })
    }

    /// Sherpa's progress callback must be `Send + 'static`, so it cannot hold our `&dyn Fn`.
    /// Run the blocking call on a scoped thread and forward ticks over a channel instead.
    fn segment(&mut self, pcm: &[f32], progress: &dyn Fn(f32)) -> Result<Vec<(f32, f32, i32)>> {
        let inner = &mut self.inner;
        let samples = pcm.to_vec();

        let out = std::thread::scope(|scope| {
            let (tx, rx) = mpsc::channel::<(i32, i32)>();
            let worker = scope.spawn(move || {
                inner.compute(
                    samples,
                    Some(Box::new(move |done, total| {
                        let _ = tx.send((done, total));
                        // sherpa ignores this; there is no way to abort mid-pass
                        0
                    })),
                )
            });
            for (done, total) in rx {
                if total > 0 {
                    progress(SEGMENT_SHARE * (done as f32 / total as f32).clamp(0.0, 1.0));
                }
            }
            worker.join()
        })
        .map_err(|_| Error::Diarize("segmentation thread panicked".into()))?;

        match out {
            Ok(segments) => Ok(segments
                .into_iter()
                .map(|s| (s.start, s.end, s.speaker))
                .collect()),
            // a recording with no speech at all is a normal outcome, not a failure
            Err(e) if e.to_string().contains("No segments found") => {
                warn!("no speech segments; diarization is empty");
                Ok(Vec::new())
            }
            Err(e) => Err(Error::Diarize(e.to_string())),
        }
    }

    /// One speaker's embedding: the mean of their longest turns, re-normalised. Falls back
    /// to their whole speech concatenated when every turn is too short to embed alone.
    pub fn centroid(&mut self, pcm: &[f32], turns: &[Turn], speaker: u32) -> Result<Vec<f32>> {
        let mut mine: Vec<&Turn> = turns.iter().filter(|t| t.speaker == speaker).collect();
        mine.sort_unstable_by_key(|t| std::cmp::Reverse(t.end_ms - t.start_ms));

        let mut sum = vec![0.0f32; self.embed.embedding_size];
        let mut used = 0usize;
        for turn in mine.iter().take(CENTROID_TURNS) {
            if turn.end_ms - turn.start_ms < MIN_EMBED_MS {
                break; // sorted by length, so everything after is shorter too
            }
            let end_ms = turn.end_ms.min(turn.start_ms + MAX_EMBED_MS);
            let clip = slice(pcm, turn.start_ms, end_ms).to_vec();
            match self
                .embed
                .compute_speaker_embedding(clip, TARGET_SAMPLE_RATE)
            {
                Ok(v) => {
                    for (acc, x) in sum.iter_mut().zip(normalize(v)) {
                        *acc += x;
                    }
                    used += 1;
                }
                Err(e) => debug!(speaker, "turn embedding failed: {e}"),
            }
        }

        if used == 0 {
            let mut joined = Vec::new();
            for turn in &mine {
                joined.extend_from_slice(slice(pcm, turn.start_ms, turn.end_ms));
                if joined.len() as u64 >= samples_at(MAX_EMBED_MS) {
                    break;
                }
            }
            debug!(
                speaker,
                samples = joined.len(),
                "centroid from joined turns"
            );
            return self
                .embed
                .compute_speaker_embedding(joined, TARGET_SAMPLE_RATE)
                .map(normalize)
                .map_err(|e| Error::Diarize(format!("speaker {speaker}: {e}")));
        }

        Ok(normalize(sum))
    }

    /// Rejoin the fragments sherpa over-split a speaker into. Each fragment gets a centroid;
    /// average-linkage merges those whose voices agree, cut at the merge threshold. Fragments
    /// too short to embed are folded into whichever real speaker is nearest in time -- a lone
    /// "yeah" should not become its own speaker.
    fn recluster(&mut self, pcm: &[f32], turns: &mut [Turn], cancel: &CancelToken) -> Result<()> {
        let frags = turns.iter().map(|t| t.speaker + 1).max().unwrap_or(0) as usize;
        if frags < 2 {
            return Ok(());
        }

        let mut centroids = Vec::with_capacity(frags);
        for f in 0..frags as u32 {
            cancel.check()?;
            centroids.push(self.centroid(pcm, turns, f)?);
        }

        // a fragment whose turns were all too short embeds to nothing; cluster only the rest
        let strong: Vec<usize> = (0..frags).filter(|&i| is_embedded(&centroids[i])).collect();
        if strong.is_empty() {
            return Ok(());
        }
        let strong_centroids: Vec<&[f32]> =
            strong.iter().map(|&i| centroids[i].as_slice()).collect();
        let labels = agglomerate(&strong_centroids, self.config.threshold);

        let mut speaker_of: Vec<Option<u32>> = vec![None; frags];
        for (k, &f) in strong.iter().enumerate() {
            speaker_of[f] = Some(labels[k]);
        }

        // real speakers as (midpoint, speaker), in time order -> a weak turn borrows the label
        // of the nearest one. built before the rewrite below, while turn.speaker is still a frag.
        let anchors: Vec<(u64, u32)> = turns
            .iter()
            .filter_map(|t| speaker_of[t.speaker as usize].map(|s| (midpoint(t), s)))
            .collect();

        for turn in turns.iter_mut() {
            turn.speaker = match speaker_of[turn.speaker as usize] {
                Some(s) => s,
                None => nearest(&anchors, midpoint(turn)),
            };
        }

        prune_tiny_speakers(turns);
        info!(
            fragments = frags,
            speakers = turns.iter().map(|t| t.speaker + 1).max().unwrap_or(0),
            "reclustered fragments"
        );
        renumber(turns);
        Ok(())
    }
}

/// Sherpa numbers clusters however clustering happened to fall out. Renumber by first
/// appearance so "Speaker 1" is whoever opened the meeting, on every run.
fn relabel(mut segments: Vec<(f32, f32, i32)>) -> Vec<Turn> {
    segments.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1)));

    let mut order: Vec<i32> = Vec::new();
    segments
        .into_iter()
        .filter(|&(start, end, _)| end > start)
        .map(|(start, end, cluster)| {
            let speaker = match order.iter().position(|&c| c == cluster) {
                Some(i) => i,
                None => {
                    order.push(cluster);
                    order.len() - 1
                }
            };
            Turn {
                start_ms: (start.max(0.0) * 1000.0) as u64,
                end_ms: (end.max(0.0) * 1000.0) as u64,
                speaker: speaker as u32,
            }
        })
        .collect()
}

/// Merge fragment centroids by average-linkage (UPGMA) until the closest two groups are
/// farther apart than `threshold` in cosine distance. Returns a speaker id per input
/// centroid. Average-linkage, unlike sherpa's complete-linkage, tolerates a single noisy
/// turn: one bad pair cannot hold two of a speaker's fragments apart.
fn agglomerate(centroids: &[&[f32]], threshold: f32) -> Vec<u32> {
    let n = centroids.len();
    let dist = |a: usize, b: usize| -> f32 {
        // unit vectors -> cosine distance is 1 - dot
        1.0 - centroids[a].iter().zip(centroids[b]).map(|(x, y)| x * y).sum::<f32>()
    };

    let mut members: Vec<Vec<usize>> = (0..n).map(|i| vec![i]).collect();
    let mut alive: Vec<bool> = vec![true; n];
    loop {
        let live: Vec<usize> = (0..n).filter(|&i| alive[i]).collect();
        let mut best = (threshold, usize::MAX, usize::MAX);
        for (i, &a) in live.iter().enumerate() {
            for &b in &live[i + 1..] {
                let mut sum = 0.0;
                for &x in &members[a] {
                    for &y in &members[b] {
                        sum += dist(x, y);
                    }
                }
                let avg = sum / (members[a].len() * members[b].len()) as f32;
                if avg < best.0 {
                    best = (avg, a, b);
                }
            }
        }
        let (_, a, b) = best;
        if a == usize::MAX {
            break;
        }
        let moved = std::mem::take(&mut members[b]);
        members[a].extend(moved);
        alive[b] = false;
    }

    let mut speaker = vec![0u32; n];
    for (id, g) in (0..n).filter(|&i| alive[i]).enumerate() {
        for &m in &members[g] {
            speaker[m] = id as u32;
        }
    }
    speaker
}

/// Reassign every turn of a below-floor speaker to the real speaker nearest in time. A
/// backchannel "yeah" belongs to whoever was holding the floor around it. No-op when every
/// speaker clears the floor, or none does (a uniformly quiet recording keeps its clusters).
fn prune_tiny_speakers(turns: &mut [Turn]) {
    let n = turns.iter().map(|t| t.speaker + 1).max().unwrap_or(0) as usize;
    let mut speech = vec![0u64; n];
    for t in turns.iter() {
        speech[t.speaker as usize] += t.end_ms - t.start_ms;
    }
    let kept: Vec<bool> = speech.iter().map(|&d| d >= MIN_SPEAKER_MS).collect();
    if !kept.iter().any(|&k| k) || kept.iter().all(|&k| k) {
        return;
    }
    let anchors: Vec<(u64, u32)> = turns
        .iter()
        .filter(|t| kept[t.speaker as usize])
        .map(|t| (midpoint(t), t.speaker))
        .collect();
    for turn in turns.iter_mut() {
        if !kept[turn.speaker as usize] {
            turn.speaker = nearest(&anchors, midpoint(turn));
        }
    }
}

fn midpoint(t: &Turn) -> u64 {
    t.start_ms + (t.end_ms - t.start_ms) / 2
}

/// Speaker of the anchor nearest `mid` in time. `anchors` is never empty at the call site.
fn nearest(anchors: &[(u64, u32)], mid: u64) -> u32 {
    anchors
        .iter()
        .min_by_key(|(m, _)| m.abs_diff(mid))
        .map_or(0, |&(_, s)| s)
}

/// Renumber speakers by first appearance so "Speaker 1" opens the meeting on every run.
/// Turns are already in start order.
fn renumber(turns: &mut [Turn]) {
    let mut order: Vec<u32> = Vec::new();
    for turn in turns.iter_mut() {
        turn.speaker = match order.iter().position(|&s| s == turn.speaker) {
            Some(i) => i as u32,
            None => {
                order.push(turn.speaker);
                (order.len() - 1) as u32
            }
        };
    }
}

/// A centroid is all-zero only when every turn feeding it was too short to embed.
fn is_embedded(centroid: &[f32]) -> bool {
    centroid.iter().any(|&x| x != 0.0)
}

fn slice(pcm: &[f32], start_ms: u64, end_ms: u64) -> &[f32] {
    let lo = (samples_at(start_ms) as usize).min(pcm.len());
    let hi = (samples_at(end_ms) as usize).min(pcm.len()).max(lo);
    &pcm[lo..hi]
}

fn samples_at(ms: u64) -> u64 {
    ms * TARGET_SAMPLE_RATE as u64 / 1000
}

/// Cosine similarity is the only thing these vectors are ever compared with, so store them
/// unit length and let the comparison be a dot product.
fn normalize(mut v: Vec<f32>) -> Vec<f32> {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > f32::EPSILON {
        for x in &mut v {
            *x /= norm;
        }
    }
    v
}

fn threads() -> usize {
    std::thread::available_parallelism().map_or(4, |n| n.get())
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clusters_are_renumbered_by_first_appearance() {
        // sherpa hands back clusters 7, 3, 7 in arbitrary order; 3 speaks first
        let turns = relabel(vec![(10.0, 12.0, 7), (0.0, 2.0, 3), (4.0, 6.0, 7)]);
        let ids: Vec<u32> = turns.iter().map(|t| t.speaker).collect();
        assert_eq!(ids, [0, 1, 1], "cluster 3 opens, so it becomes speaker 0");
    }

    #[test]
    fn turns_come_back_sorted_and_in_milliseconds() {
        let turns = relabel(vec![(4.5, 6.25, 1), (0.0, 2.0, 0)]);
        assert_eq!(turns[0].start_ms, 0);
        assert_eq!((turns[1].start_ms, turns[1].end_ms), (4_500, 6_250));
    }

    #[test]
    fn empty_turns_are_dropped() {
        assert!(relabel(vec![(3.0, 3.0, 0), (-1.0, -1.0, 1)]).is_empty());
    }

    #[test]
    fn normalising_gives_unit_length() {
        let v = normalize(vec![3.0, 4.0]);
        assert!(
            (v.iter().map(|x| x * x).sum::<f32>() - 1.0).abs() < 1e-6,
            "{v:?}"
        );
    }

    #[test]
    fn a_zero_vector_survives_normalising() {
        assert_eq!(normalize(vec![0.0; 4]), vec![0.0; 4]);
    }

    #[test]
    fn slicing_clamps_to_the_buffer() {
        let pcm = vec![0.0f32; TARGET_SAMPLE_RATE as usize]; // 1 s
        assert_eq!(slice(&pcm, 0, 500).len(), 8_000);
        assert_eq!(slice(&pcm, 900, 5_000).len(), 1_600);
        assert!(slice(&pcm, 5_000, 9_000).is_empty());
    }

    #[test]
    fn average_linkage_merges_a_speaker_split_into_two_fragments() {
        // two tight fragments of one voice, one of another; a noisy pair inside the first
        // voice would block complete-linkage but not this.
        let a1 = normalize(vec![1.0, 0.0, 0.05]);
        let a2 = normalize(vec![0.98, 0.0, -0.05]);
        let b = normalize(vec![0.0, 1.0, 0.0]);
        let cs: Vec<&[f32]> = vec![&a1, &a2, &b];
        let ids = agglomerate(&cs, 0.5);
        assert_eq!(ids[0], ids[1], "the two fragments of voice A merge");
        assert_ne!(ids[0], ids[2], "voice B stays separate");
    }

    #[test]
    fn a_threshold_of_zero_merges_nothing() {
        let a = normalize(vec![1.0, 0.0]);
        let b = normalize(vec![0.9, 0.1]);
        let cs: Vec<&[f32]> = vec![&a, &b];
        let ids = agglomerate(&cs, 0.0);
        assert_ne!(ids[0], ids[1]);
    }

    #[test]
    fn everything_collapses_to_one_speaker_at_threshold_two() {
        let a = normalize(vec![1.0, 0.0]);
        let b = normalize(vec![-1.0, 0.0]);
        let cs: Vec<&[f32]> = vec![&a, &b];
        let ids = agglomerate(&cs, 2.1);
        assert_eq!(ids[0], ids[1]);
    }

    #[test]
    fn renumbering_is_by_first_appearance() {
        let mut turns = vec![
            Turn { start_ms: 0, end_ms: 1, speaker: 5 },
            Turn { start_ms: 1, end_ms: 2, speaker: 2 },
            Turn { start_ms: 2, end_ms: 3, speaker: 5 },
        ];
        renumber(&mut turns);
        assert_eq!(turns.iter().map(|t| t.speaker).collect::<Vec<_>>(), [0, 1, 0]);
    }

    #[test]
    fn a_tiny_speaker_is_folded_into_the_nearest_real_one() {
        // speaker 0 holds the floor; speaker 1 is a lone 1 s "yeah" mid-stretch -> pruned
        let mut turns = vec![
            Turn { start_ms: 0, end_ms: 20_000, speaker: 0 },
            Turn { start_ms: 20_000, end_ms: 21_000, speaker: 1 },
            Turn { start_ms: 21_000, end_ms: 40_000, speaker: 0 },
        ];
        prune_tiny_speakers(&mut turns);
        assert_eq!(turns.iter().map(|t| t.speaker).collect::<Vec<_>>(), [0, 0, 0]);
    }

    #[test]
    fn pruning_keeps_everyone_when_all_clear_the_floor() {
        let mut turns = vec![
            Turn { start_ms: 0, end_ms: 15_000, speaker: 0 },
            Turn { start_ms: 15_000, end_ms: 30_000, speaker: 1 },
        ];
        prune_tiny_speakers(&mut turns);
        assert_eq!(turns[1].speaker, 1);
    }

    #[test]
    fn pruning_is_a_noop_when_nobody_clears_the_floor() {
        // uniformly quiet recording: keep the clusters rather than collapse to one
        let mut turns = vec![
            Turn { start_ms: 0, end_ms: 2_000, speaker: 0 },
            Turn { start_ms: 2_000, end_ms: 4_000, speaker: 1 },
        ];
        prune_tiny_speakers(&mut turns);
        assert_eq!(turns.iter().map(|t| t.speaker).collect::<Vec<_>>(), [0, 1]);
    }

    #[test]
    fn a_weak_turn_borrows_its_nearest_neighbour() {
        let anchors = [(1_000u64, 0u32), (9_000, 1)];
        assert_eq!(nearest(&anchors, 2_000), 0);
        assert_eq!(nearest(&anchors, 8_000), 1);
    }

    #[test]
    fn an_all_zero_centroid_is_not_embedded() {
        assert!(!is_embedded(&[0.0, 0.0, 0.0]));
        assert!(is_embedded(&[0.0, 0.1, 0.0]));
    }

    #[test]
    fn a_missing_model_is_reported_before_sherpa_sees_it() {
        let err = Diarizer::load(
            Path::new("/nonexistent/seg.onnx"),
            Path::new("/nonexistent/emb.onnx"),
            Config::default(),
        )
        .unwrap_err();
        assert!(
            matches!(&err, Error::ModelMissing { name } if name == "seg.onnx"),
            "{err}"
        );
    }
}
