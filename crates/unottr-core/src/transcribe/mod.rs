//! Pcm in, timestamped text in the database out — resumable if the process dies.

pub mod chunk;
pub mod engine;
pub mod model;

use std::path::{Path, PathBuf};

use rusqlite::{Connection, params};
use tracing::{info, warn};

use crate::cancel::CancelToken;
use crate::db::recordings;
use crate::error::Result;
use crate::media::read_pcm_f32;

pub use chunk::{Chunk, MAX_CHUNK_MS, MAX_GAP_MS, Span};
pub use engine::{Device, GpuInfo, Options, Resolved, Transcriber, Utterance, Word, gpus, resolve};
pub use model::{MODELS, ModelSpec, ModelStore, VAD};

#[derive(Debug, Clone)]
pub struct Job {
    pub recording_id: i64,
    pub pcm: PathBuf,
    pub model: PathBuf,
    pub vad_model: PathBuf,
    pub device: Device,
    pub options: Options,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    pub device: Resolved,
    pub chunks: usize,
    /// Chunks already checkpointed when we started; 0 on a fresh run.
    pub resumed_from: usize,
    pub segments: usize,
    pub speech_ms: u64,
}

/// Transcribe one recording, checkpointing after every chunk.
///
/// Safe to call again after a crash: the chunk plan is a pure function of the pcm, so the
/// boundaries are identical and `last_chunk_idx` still means what it meant.
pub fn run(
    db: &crate::Database,
    job: &Job,
    progress: &dyn Fn(f32),
    cancel: &CancelToken,
) -> Result<Report> {
    cancel.check()?;
    let samples = read_pcm_f32(&job.pcm)?;
    let device = resolve(job.device);

    let spans = chunk::detect_speech(&samples, &job.vad_model)?;
    let chunks = chunk::pack(&spans, MAX_CHUNK_MS, MAX_GAP_MS);
    let speech_ms = chunks.iter().map(Chunk::duration_ms).sum();
    info!(chunks = chunks.len(), speech_ms, ?device, "chunk plan");

    let mut conn = db.connect()?;
    let resumed_from = rewind(&mut conn, job.recording_id)?;
    if resumed_from > 0 {
        info!(resumed_from, "resuming");
    }
    if resumed_from >= chunks.len() {
        // plan shrank (different pcm?) — nothing sensible left to do but report it
        return Ok(Report {
            device,
            chunks: chunks.len(),
            resumed_from,
            segments: count_segments(&conn, job.recording_id)?,
            speech_ms,
        });
    }

    let transcriber = Transcriber::load(&job.model, job.device, job.options.clone())?;

    for chunk in &chunks[resumed_from..] {
        cancel.check()?;
        let mut utterances = transcriber.run(&samples[chunk.range(samples.len())], cancel)?;
        for u in &mut utterances {
            u.shift(chunk.start_ms);
        }
        checkpoint(&mut conn, job.recording_id, chunk, &utterances)?;
        progress(((chunk.idx + 1) as f32 / chunks.len() as f32).clamp(0.0, 1.0));
    }

    let segments = count_segments(&conn, job.recording_id)?;
    conn.execute(
        "UPDATE recordings SET status = 'diarizing', stage_detail = NULL, error = NULL, updated_at = ?2
         WHERE id = ?1",
        params![job.recording_id, recordings::now()],
    )?;

    Ok(Report {
        device,
        chunks: chunks.len(),
        resumed_from,
        segments,
        speech_ms,
    })
}

/// Drop anything past the checkpoint and report where to restart. Guards the window
/// between inserting a chunk's segments and recording that we did.
fn rewind(conn: &mut Connection, recording_id: i64) -> Result<usize> {
    let last = recordings::last_chunk_idx(conn, recording_id)?;
    let Some(last) = last else {
        // no checkpoint = start over, and any orphan segments are from a run that never
        // got to write one
        conn.execute(
            "DELETE FROM segments WHERE recording_id = ?1",
            [recording_id],
        )?;
        return Ok(0);
    };

    let dropped = conn.execute(
        "DELETE FROM segments WHERE recording_id = ?1 AND chunk_idx > ?2",
        params![recording_id, last],
    )?;
    if dropped > 0 {
        warn!(dropped, "discarded segments past the checkpoint");
    }
    Ok((last + 1).max(0) as usize)
}

fn checkpoint(
    conn: &mut Connection,
    recording_id: i64,
    chunk: &Chunk,
    utterances: &[Utterance],
) -> Result<()> {
    let tx = conn.transaction()?;
    {
        let mut insert = tx.prepare_cached(
            "INSERT INTO segments (recording_id, chunk_idx, start_ms, end_ms, text, words)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;
        for u in utterances {
            let words = serde_json::to_string(&u.words).unwrap_or_else(|_| "[]".into());
            insert.execute(params![
                recording_id,
                chunk.idx as i64,
                u.start_ms as i64,
                u.end_ms as i64,
                u.text,
                words,
            ])?;
        }
    }
    tx.execute(
        "UPDATE recordings SET last_chunk_idx = ?2, status = 'transcribing', stage_detail = ?3, updated_at = ?4
         WHERE id = ?1",
        params![
            recording_id,
            chunk.idx as i64,
            format!("chunk {}", chunk.idx),
            recordings::now(),
        ],
    )?;
    tx.commit()?;
    Ok(())
}

fn count_segments(conn: &Connection, recording_id: i64) -> Result<usize> {
    Ok(conn.query_row(
        "SELECT count(*) FROM segments WHERE recording_id = ?1",
        [recording_id],
        |row| row.get::<_, i64>(0),
    )? as usize)
}

/// Where the pcm for a recording lives. Mirrors the naming the cli uses in phase 01.
pub fn pcm_path_for(cache_dir: &Path, source: &Path, audio_index: u32) -> PathBuf {
    let stem = source.file_stem().unwrap_or_default().to_string_lossy();
    cache_dir.join(format!("{stem}.t{audio_index}.pcm"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Database;

    fn db_with_recording() -> (tempfile::TempDir, Database, i64) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path().join("t.db")).unwrap();
        let conn = db.connect().unwrap();
        let id = recordings::stub(&conn, Path::new("/tmp/a.mkv"), Some(1000)).unwrap();
        (dir, db, id)
    }

    fn utterance(text: &str) -> Utterance {
        Utterance {
            start_ms: 0,
            end_ms: 500,
            text: text.into(),
            words: vec![Word {
                text: text.into(),
                start_ms: 0,
                end_ms: 500,
                p: 1.0,
            }],
        }
    }

    #[test]
    fn stubbing_the_same_path_twice_reuses_the_row() {
        let (_d, db, id) = db_with_recording();
        let conn = db.connect().unwrap();
        assert_eq!(
            recordings::stub(&conn, Path::new("/tmp/a.mkv"), None).unwrap(),
            id
        );
    }

    #[test]
    fn a_checkpoint_moves_the_resume_point() {
        let (_d, db, id) = db_with_recording();
        let mut conn = db.connect().unwrap();
        assert_eq!(rewind(&mut conn, id).unwrap(), 0);

        let chunk = Chunk {
            idx: 0,
            start_ms: 2_000,
            end_ms: 5_000,
        };
        let mut u = utterance("hello");
        u.shift(chunk.start_ms);
        checkpoint(&mut conn, id, &chunk, &[u]).unwrap();

        assert_eq!(rewind(&mut conn, id).unwrap(), 1);
        let (start, end, words): (i64, i64, String) = conn
            .query_row("SELECT start_ms, end_ms, words FROM segments", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap();
        assert_eq!((start, end), (2_000, 2_500), "chunk offset applied");
        // words share the segment clock; they drifted once because only the segment was shifted
        assert!(words.contains("\"start_ms\":2000"), "{words}");
    }

    #[test]
    fn segments_past_the_checkpoint_are_discarded() {
        let (_d, db, id) = db_with_recording();
        let mut conn = db.connect().unwrap();

        for idx in 0..3 {
            let chunk = Chunk {
                idx,
                start_ms: idx as u64 * 1_000,
                end_ms: idx as u64 * 1_000 + 500,
            };
            checkpoint(&mut conn, id, &chunk, &[utterance("x")]).unwrap();
        }
        // simulate dying after inserting chunk 2 but before its update landed
        conn.execute(
            "UPDATE recordings SET last_chunk_idx = 1 WHERE id = ?1",
            [id],
        )
        .unwrap();

        assert_eq!(rewind(&mut conn, id).unwrap(), 2);
        assert_eq!(count_segments(&conn, id).unwrap(), 2);
    }

    #[test]
    fn a_run_that_never_checkpointed_starts_clean() {
        let (_d, db, id) = db_with_recording();
        let mut conn = db.connect().unwrap();
        conn.execute(
            "INSERT INTO segments (recording_id, chunk_idx, start_ms, end_ms, text)
             VALUES (?1, 0, 0, 1, 'orphan')",
            [id],
        )
        .unwrap();

        assert_eq!(rewind(&mut conn, id).unwrap(), 0);
        assert_eq!(count_segments(&conn, id).unwrap(), 0);
    }

    #[test]
    fn pcm_path_matches_the_cli_naming() {
        let p = pcm_path_for(Path::new("/cache"), Path::new("/rec/meeting.mkv"), 1);
        assert_eq!(p, Path::new("/cache/meeting.t1.pcm"));
    }
}
