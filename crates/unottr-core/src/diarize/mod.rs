//! Who spoke when, and which transcript rows belong to them.
//!
//! Runs after transcription and over the whole recording at once: clustering has to see
//! every voice before it can decide how many there are.

pub mod engine;
pub mod merge;
pub mod mic;
pub mod model;

use std::path::PathBuf;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use tracing::info;

use crate::cancel::CancelToken;
use crate::db::recordings;
use crate::error::Result;
use crate::media::read_pcm_f32;
use crate::transcribe::engine::Word;

pub use engine::{Config, DEFAULT_THRESHOLD, Diarizer};
pub use merge::{Assigned, Piece, Segment, assign};
pub use model::{EMBEDDINGS, SEGMENTATION, default_embedding, find_embedding};

/// A stretch of one speaker's voice. Timestamps are absolute, on the recording's clock.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Turn {
    pub start_ms: u64,
    pub end_ms: u64,
    pub speaker: u32,
}

/// `embeddings[i]` is the centroid for speaker `i` — unit length, so comparing two is a dot
/// product. Stored per recording from day one (decision #17) even though nothing compares
/// across recordings in v1.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Diarization {
    pub turns: Vec<Turn>,
    pub embeddings: Vec<Vec<f32>>,
}

impl Diarization {
    pub fn speakers(&self) -> usize {
        self.embeddings.len()
    }
}

#[derive(Debug, Clone)]
pub struct Job {
    pub recording_id: i64,
    /// The track to cluster. With `mic_pcm` set this is the desktop track.
    pub pcm: PathBuf,
    /// Set only when phase 01 identified a mic track. Everything on it is the local user.
    pub mic_pcm: Option<PathBuf>,
    pub segmentation: PathBuf,
    pub embedding: PathBuf,
    /// Only read on the mic path.
    pub vad_model: PathBuf,
    pub config: Config,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    pub speakers: usize,
    pub turns: usize,
    pub segments: usize,
    /// Segments a speaker change ran through, so they were cut in two.
    pub split: usize,
    /// Segments no turn overlapped. Rendered without a name rather than guessed at.
    pub unattributed: usize,
    pub mic_track: bool,
}

/// Diarization takes nearly all the wall clock; the database work is a rounding error.
const DIARIZE_SHARE: f32 = 0.97;

pub fn run(
    db: &crate::Database,
    job: &Job,
    progress: &dyn Fn(f32),
    cancel: &CancelToken,
) -> Result<Report> {
    cancel.check()?;
    let mut conn = db.connect()?;
    let segments = load_segments(&conn, job.recording_id)?;

    let pcm = read_pcm_f32(&job.pcm)?;
    let mut diarizer = Diarizer::load(&job.segmentation, &job.embedding, job.config)?;
    let stage = |f: f32| progress(f * DIARIZE_SHARE);

    let (diarization, labels): (Diarization, Vec<String>) = match &job.mic_pcm {
        Some(path) => {
            let mic_pcm = read_pcm_f32(path)?;
            let you = mic::detect(&mic_pcm, &job.vad_model)?;
            let desktop = diarizer.run(&pcm, &stage, cancel)?;
            // the local user's centroid comes off their own track, never the mixed one
            let you_embedding = diarizer.centroid(&mic_pcm, &you, mic::YOU)?;
            let combined = mic::combine(you, you_embedding, desktop);
            let labels = (0..combined.speakers() as u32).map(mic::label).collect();
            (combined, labels)
        }
        None => {
            let out = diarizer.run(&pcm, &stage, cancel)?;
            let labels = (1..=out.speakers())
                .map(|n| format!("Speaker {n}"))
                .collect();
            (out, labels)
        }
    };
    drop(diarizer);
    cancel.check()?;

    let whole: Vec<Segment> = segments.iter().map(|l| l.seg.clone()).collect();
    let assigned = assign(&whole, &diarization.turns);
    let counts = persist(
        &mut conn,
        job.recording_id,
        &labels,
        &diarization,
        &segments,
        &assigned,
    )?;
    progress(1.0);

    let report = Report {
        speakers: diarization.speakers(),
        turns: diarization.turns.len(),
        segments: segments.len(),
        split: counts.0,
        unattributed: counts.1,
        mic_track: job.mic_pcm.is_some(),
    };
    info!(?report, "diarize done");
    Ok(report)
}

/// One logical transcript segment plus the rows it currently occupies. A previous
/// diarization may have left it as several rows; the merge algorithm must see it whole
/// again or every re-run splits the pieces further.
struct Loaded {
    seg: Segment,
    rows: Vec<i64>,
}

fn load_segments(conn: &Connection, recording_id: i64) -> Result<Vec<Loaded>> {
    let mut stmt = conn.prepare(
        "SELECT COALESCE(split_of, id), id, chunk_idx, start_ms, end_ms, text, words
         FROM segments WHERE recording_id = ?1 ORDER BY start_ms, id",
    )?;
    let rows = stmt.query_map([recording_id], |row| {
        let words: Option<String> = row.get(6)?;
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)?,
            Segment {
                id: row.get(0)?,
                chunk_idx: row.get(2)?,
                start_ms: row.get::<_, i64>(3)?.max(0) as u64,
                end_ms: row.get::<_, i64>(4)?.max(0) as u64,
                text: row.get(5)?,
                words: words
                    .and_then(|w| serde_json::from_str::<Vec<Word>>(&w).ok())
                    .unwrap_or_default(),
            },
        ))
    })?;

    let mut out: Vec<Loaded> = Vec::new();
    for row in rows {
        let (key, row_id, seg) = row?;
        match out.iter_mut().find(|l| l.seg.id == key) {
            Some(l) => {
                l.seg.start_ms = l.seg.start_ms.min(seg.start_ms);
                l.seg.end_ms = l.seg.end_ms.max(seg.end_ms);
                l.seg.text.push(' ');
                l.seg.text.push_str(&seg.text);
                l.seg.words.extend(seg.words);
                l.rows.push(row_id);
            }
            None => out.push(Loaded {
                seg,
                rows: vec![row_id],
            }),
        }
    }
    Ok(out)
}

/// Replace this recording's speakers and reattach its segments, in one transaction.
/// Returns `(split, unattributed)`.
fn persist(
    conn: &mut Connection,
    recording_id: i64,
    labels: &[String],
    diarization: &Diarization,
    loaded: &[Loaded],
    assigned: &[Assigned],
) -> Result<(usize, usize)> {
    let tx = conn.transaction()?;
    let renames = existing_names(&tx, recording_id)?;

    // cascades speaker_id back to NULL on every segment, so nothing points at a stale row
    tx.execute(
        "DELETE FROM speakers WHERE recording_id = ?1",
        [recording_id],
    )?;

    let mut speaker_ids = Vec::with_capacity(labels.len());
    for (i, label) in labels.iter().enumerate() {
        let embedding = diarization.embeddings.get(i).map(|v| to_blob(v));
        tx.execute(
            "INSERT INTO speakers (recording_id, label, display_name, embedding)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                recording_id,
                label,
                renames.iter().find(|(l, _)| l == label).map(|(_, n)| n),
                embedding,
            ],
        )?;
        speaker_ids.push(tx.last_insert_rowid());
    }

    let (mut split, mut unattributed) = (0usize, 0usize);
    for (item, current) in assigned.iter().zip(loaded) {
        let id_of = |s: Option<u32>| s.and_then(|n| speaker_ids.get(n as usize).copied());
        unattributed += item.pieces.iter().filter(|p| p.speaker.is_none()).count();
        if item.is_split() {
            split += 1;
        }

        // the row survives untouched when the shape has not changed; anything else is
        // rewritten so a re-run always lands on whisper's granularity, never on the last run's
        if !item.is_split() && current.rows.len() == 1 {
            tx.execute(
                "UPDATE segments SET speaker_id = ?2 WHERE id = ?1",
                params![current.rows[0], id_of(item.pieces[0].speaker)],
            )?;
            continue;
        }

        for row in &current.rows {
            tx.execute("DELETE FROM segments WHERE id = ?1", [row])?;
        }
        let mut insert = tx.prepare_cached(
            "INSERT INTO segments (recording_id, chunk_idx, start_ms, end_ms, text, words, speaker_id, split_of)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )?;
        for piece in &item.pieces {
            insert.execute(params![
                recording_id,
                item.chunk_idx,
                piece.start_ms as i64,
                piece.end_ms as i64,
                piece.text,
                serde_json::to_string(&piece.words).unwrap_or_else(|_| "[]".into()),
                id_of(piece.speaker),
                item.is_split().then_some(item.id),
            ])?;
        }
    }

    tx.execute(
        "UPDATE recordings SET status = 'done', stage_detail = NULL, error = NULL, updated_at = ?2
         WHERE id = ?1",
        params![recording_id, recordings::now()],
    )?;
    tx.commit()?;
    Ok((split, unattributed))
}

/// Decision #4 lets users rename speakers per recording. Re-diarizing must not silently
/// throw that away, so names come back by label.
fn existing_names(conn: &Connection, recording_id: i64) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT label, display_name FROM speakers
         WHERE recording_id = ?1 AND display_name IS NOT NULL",
    )?;
    let rows = stmt.query_map([recording_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn to_blob(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

pub fn from_blob(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

/// Labels a recording's speakers carry, in id order. Convenience for the cli and the ui.
pub fn labels_of(
    conn: &Connection,
    recording_id: i64,
) -> Result<Vec<(i64, String, Option<String>)>> {
    let mut stmt = conn.prepare(
        "SELECT id, label, display_name FROM speakers WHERE recording_id = ?1 ORDER BY id",
    )?;
    let rows = stmt.query_map([recording_id], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Existing display name for one label, or `None`. Used by tests and the rename command.
pub fn display_name(conn: &Connection, recording_id: i64, label: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT display_name FROM speakers WHERE recording_id = ?1 AND label = ?2",
            params![recording_id, label],
            |row| row.get(0),
        )
        .optional()?
        .flatten())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Database;
    use std::path::Path;

    fn word(text: &str, start_ms: u64) -> Word {
        Word {
            text: text.into(),
            start_ms,
            end_ms: start_ms + 400,
            p: 1.0,
        }
    }

    fn db_with_segments(n: usize) -> (tempfile::TempDir, Database, i64) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path().join("t.db")).unwrap();
        let conn = db.connect().unwrap();
        let id = recordings::stub(&conn, Path::new("/tmp/a.mkv"), Some(60_000)).unwrap();

        for i in 0..n as u64 {
            let words: Vec<Word> = (0..20)
                .map(|k| word(&format!("w{k}"), i * 10_000 + k * 500))
                .collect();
            conn.execute(
                "INSERT INTO segments (recording_id, chunk_idx, start_ms, end_ms, text, words)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    id,
                    i as i64,
                    (i * 10_000) as i64,
                    (i * 10_000 + 10_000) as i64,
                    "hello there",
                    serde_json::to_string(&words).unwrap(),
                ],
            )
            .unwrap();
        }
        (dir, db, id)
    }

    fn diarization(turns: Vec<Turn>, speakers: usize) -> Diarization {
        Diarization {
            turns,
            embeddings: (0..speakers).map(|i| vec![i as f32 + 1.0; 4]).collect(),
        }
    }

    #[test]
    fn embeddings_survive_the_round_trip() {
        let v = vec![0.5, -0.25, 1.0e-8, 3.0];
        assert_eq!(from_blob(&to_blob(&v)), v);
        assert_eq!(to_blob(&v).len(), 16);
    }

    #[test]
    fn a_trailing_partial_float_is_ignored() {
        assert_eq!(from_blob(&[0, 0, 0]), Vec::<f32>::new());
    }

    #[test]
    fn segments_round_trip_out_of_the_database() {
        let (_d, db, id) = db_with_segments(2);
        let conn = db.connect().unwrap();
        let segments = load_segments(&conn, id).unwrap();

        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].seg.words.len(), 20);
        assert_eq!(segments[1].seg.start_ms, 10_000);
    }

    #[test]
    fn a_segment_without_words_still_loads() {
        let (_d, db, id) = db_with_segments(0);
        let conn = db.connect().unwrap();
        conn.execute(
            "INSERT INTO segments (recording_id, chunk_idx, start_ms, end_ms, text)
             VALUES (?1, 0, 0, 500, 'x')",
            [id],
        )
        .unwrap();
        assert!(load_segments(&conn, id).unwrap()[0].seg.words.is_empty());
    }

    #[test]
    fn every_speaker_row_gets_an_embedding() {
        let (_d, db, id) = db_with_segments(2);
        let mut conn = db.connect().unwrap();
        let d = diarization(
            vec![
                Turn {
                    start_ms: 0,
                    end_ms: 10_000,
                    speaker: 0,
                },
                Turn {
                    start_ms: 10_000,
                    end_ms: 20_000,
                    speaker: 1,
                },
            ],
            2,
        );
        let segments = load_segments(&conn, id).unwrap();
        let whole: Vec<Segment> = segments.iter().map(|l| l.seg.clone()).collect();
        let assigned = assign(&whole, &d.turns);
        let labels = ["Speaker 1".to_string(), "Speaker 2".to_string()];

        persist(&mut conn, id, &labels, &d, &segments, &assigned).unwrap();

        let mut stmt = conn
            .prepare("SELECT label, embedding FROM speakers WHERE recording_id = ?1 ORDER BY id")
            .unwrap();
        let rows: Vec<(String, Option<Vec<u8>>)> = stmt
            .query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(rows.len(), 2);
        assert!(
            rows.iter()
                .all(|(_, e)| e.as_ref().is_some_and(|b| !b.is_empty()))
        );
        assert_eq!(from_blob(rows[1].1.as_ref().unwrap()), vec![2.0; 4]);
    }

    #[test]
    fn segments_come_back_attached_to_a_speaker() {
        let (_d, db, id) = db_with_segments(2);
        let mut conn = db.connect().unwrap();
        let d = diarization(
            vec![Turn {
                start_ms: 0,
                end_ms: 20_000,
                speaker: 0,
            }],
            1,
        );
        let segments = load_segments(&conn, id).unwrap();
        let whole: Vec<Segment> = segments.iter().map(|l| l.seg.clone()).collect();
        let assigned = assign(&whole, &d.turns);
        persist(&mut conn, id, &["Speaker 1".to_string()], &d, &segments, &assigned).unwrap();

        let unattached: i64 = conn
            .query_row(
                "SELECT count(*) FROM segments WHERE recording_id = ?1 AND speaker_id IS NULL",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(unattached, 0);
    }

    #[test]
    fn a_segment_no_turn_covers_stays_unattributed() {
        let (_d, db, id) = db_with_segments(1);
        let mut conn = db.connect().unwrap();
        let d = diarization(
            vec![Turn {
                start_ms: 500_000,
                end_ms: 510_000,
                speaker: 0,
            }],
            1,
        );
        let segments = load_segments(&conn, id).unwrap();
        let whole: Vec<Segment> = segments.iter().map(|l| l.seg.clone()).collect();
        let assigned = assign(&whole, &d.turns);
        let (_, unattributed) =
            persist(&mut conn, id, &["Speaker 1".into()], &d, &segments, &assigned).unwrap();

        assert_eq!(unattributed, 1);
        let speaker: Option<i64> = conn
            .query_row(
                "SELECT speaker_id FROM segments WHERE recording_id = ?1",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(speaker, None);
    }

    #[test]
    fn a_split_segment_becomes_two_rows() {
        let (_d, db, id) = db_with_segments(1);
        let mut conn = db.connect().unwrap();
        let d = diarization(
            vec![
                Turn {
                    start_ms: 0,
                    end_ms: 5_000,
                    speaker: 0,
                },
                Turn {
                    start_ms: 5_000,
                    end_ms: 10_000,
                    speaker: 1,
                },
            ],
            2,
        );
        let segments = load_segments(&conn, id).unwrap();
        let whole: Vec<Segment> = segments.iter().map(|l| l.seg.clone()).collect();
        let assigned = assign(&whole, &d.turns);
        assert!(assigned[0].is_split());

        let labels = ["Speaker 1".to_string(), "Speaker 2".to_string()];
        let (split, _) = persist(&mut conn, id, &labels, &d, &segments, &assigned).unwrap();
        assert_eq!(split, 1);

        let rows: i64 = conn
            .query_row(
                "SELECT count(*) FROM segments WHERE recording_id = ?1",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rows, 2);
        let distinct: i64 = conn
            .query_row(
                "SELECT count(DISTINCT speaker_id) FROM segments WHERE recording_id = ?1",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(distinct, 2);
    }

    #[test]
    fn re_diarizing_a_split_segment_does_not_fragment_further() {
        let (_d, db, id) = db_with_segments(1);
        let mut conn = db.connect().unwrap();
        let d = diarization(
            vec![
                Turn { start_ms: 0, end_ms: 5_000, speaker: 0 },
                Turn { start_ms: 5_000, end_ms: 10_000, speaker: 1 },
            ],
            2,
        );
        let labels = ["Speaker 1".to_string(), "Speaker 2".to_string()];

        for _ in 0..3 {
            let segments = load_segments(&conn, id).unwrap();
            // the split pieces rejoin into the one whisper segment before every pass
            assert_eq!(segments.len(), 1);
            let whole: Vec<Segment> = segments.iter().map(|l| l.seg.clone()).collect();
            let assigned = assign(&whole, &d.turns);
            persist(&mut conn, id, &labels, &d, &segments, &assigned).unwrap();
        }

        let rows: i64 = conn
            .query_row("SELECT count(*) FROM segments WHERE recording_id = ?1", [id], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 2);
    }

    #[test]
    fn a_rename_survives_re_diarizing() {
        let (_d, db, id) = db_with_segments(1);
        let mut conn = db.connect().unwrap();
        let d = diarization(
            vec![Turn {
                start_ms: 0,
                end_ms: 10_000,
                speaker: 0,
            }],
            1,
        );
        let segments = load_segments(&conn, id).unwrap();
        let whole: Vec<Segment> = segments.iter().map(|l| l.seg.clone()).collect();
        let assigned = assign(&whole, &d.turns);
        let labels = ["Speaker 1".to_string()];

        persist(&mut conn, id, &labels, &d, &segments, &assigned).unwrap();
        conn.execute(
            "UPDATE speakers SET display_name = 'Ada' WHERE recording_id = ?1",
            [id],
        )
        .unwrap();

        let segments = load_segments(&conn, id).unwrap();
        let whole: Vec<Segment> = segments.iter().map(|l| l.seg.clone()).collect();
        let assigned = assign(&whole, &d.turns);
        persist(&mut conn, id, &labels, &d, &segments, &assigned).unwrap();

        assert_eq!(
            display_name(&conn, id, "Speaker 1").unwrap().as_deref(),
            Some("Ada")
        );
    }

    #[test]
    fn the_recording_ends_up_marked_done() {
        let (_d, db, id) = db_with_segments(1);
        let mut conn = db.connect().unwrap();
        let d = Diarization::default();
        let segments = load_segments(&conn, id).unwrap();
        let whole: Vec<Segment> = segments.iter().map(|l| l.seg.clone()).collect();
        let assigned = assign(&whole, &d.turns);
        persist(&mut conn, id, &[], &d, &segments, &assigned).unwrap();

        let status: String = conn
            .query_row("SELECT status FROM recordings WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(status, "done");
    }

    #[test]
    fn search_still_finds_a_split_segment() {
        let (_d, db, id) = db_with_segments(1);
        let mut conn = db.connect().unwrap();
        let d = diarization(
            vec![
                Turn {
                    start_ms: 0,
                    end_ms: 5_000,
                    speaker: 0,
                },
                Turn {
                    start_ms: 5_000,
                    end_ms: 10_000,
                    speaker: 1,
                },
            ],
            2,
        );
        let segments = load_segments(&conn, id).unwrap();
        let whole: Vec<Segment> = segments.iter().map(|l| l.seg.clone()).collect();
        let assigned = assign(&whole, &d.turns);
        let labels = ["Speaker 1".to_string(), "Speaker 2".to_string()];
        persist(&mut conn, id, &labels, &d, &segments, &assigned).unwrap();

        // the split rewrote text from words, so the fts index must have followed
        let hits: i64 = conn
            .query_row(
                "SELECT count(*) FROM segments_fts WHERE segments_fts MATCH 'w0'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1);
    }
}
