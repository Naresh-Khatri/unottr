use rusqlite::Connection;
use tracing::info;

use crate::error::Result;

/// Forward-only migrations, applied in order. Never edit a migration that has shipped;
/// append a new one. Index = target `user_version`.
pub const MIGRATIONS: &[&str] = &[V1, V2, V3, V4];

pub fn current_version(conn: &Connection) -> Result<u32> {
    Ok(conn.query_row("PRAGMA user_version", [], |row| row.get(0))?)
}

pub fn apply(conn: &mut Connection) -> Result<()> {
    let from = current_version(conn)?;
    let to = MIGRATIONS.len() as u32;
    if from >= to {
        return Ok(());
    }

    for (idx, sql) in MIGRATIONS.iter().enumerate().skip(from as usize) {
        let version = idx as u32 + 1;
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        // pragma takes no bind params; version is ours, not user input
        tx.pragma_update(None, "user_version", version)?;
        tx.commit()?;
        info!(version, "applied migration");
    }

    Ok(())
}

const V1: &str = r#"
CREATE TABLE recordings (
  id             INTEGER PRIMARY KEY,
  path           TEXT    NOT NULL UNIQUE,
  fp_size        INTEGER NOT NULL,
  fp_head        BLOB    NOT NULL,
  fp_tail        BLOB    NOT NULL,
  container      TEXT,
  duration_ms    INTEGER,
  recorded_at    INTEGER,
  status         TEXT    NOT NULL,
  stage_detail   TEXT,
  error          TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_chunk_idx INTEGER,
  available      INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_recordings_status ON recordings(status);
CREATE INDEX idx_recordings_fp ON recordings(fp_size, fp_head);

CREATE TABLE speakers (
  id           INTEGER PRIMARY KEY,
  recording_id INTEGER NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  label        TEXT    NOT NULL,
  display_name TEXT,
  embedding    BLOB,
  UNIQUE(recording_id, label)
);

CREATE TABLE segments (
  id           INTEGER PRIMARY KEY,
  recording_id INTEGER NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  chunk_idx    INTEGER NOT NULL,
  start_ms     INTEGER NOT NULL,
  end_ms       INTEGER NOT NULL,
  text         TEXT    NOT NULL,
  words        TEXT,
  speaker_id   INTEGER REFERENCES speakers(id) ON DELETE SET NULL
);
CREATE INDEX idx_segments_recording ON segments(recording_id, start_ms);
CREATE INDEX idx_segments_chunk ON segments(recording_id, chunk_idx);

CREATE VIRTUAL TABLE segments_fts USING fts5(
  text,
  content='segments',
  content_rowid='id',
  tokenize='unicode61'
);

CREATE TRIGGER segments_ai AFTER INSERT ON segments BEGIN
  INSERT INTO segments_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER segments_ad AFTER DELETE ON segments BEGIN
  INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER segments_au AFTER UPDATE ON segments BEGIN
  INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO segments_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TABLE watch_folders (
  id         INTEGER PRIMARY KEY,
  path       TEXT    NOT NULL UNIQUE,
  track_rule TEXT    NOT NULL DEFAULT 'auto',
  enabled    INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"#;

/// Diarization splits a transcript segment when a speaker change runs through it. Without a
/// back-pointer the pieces are indistinguishable from whisper's own rows, so re-diarizing
/// would split the pieces again and whisper's segmentation could never be recovered.
const V2: &str = r#"
ALTER TABLE segments ADD COLUMN split_of INTEGER;
CREATE INDEX idx_segments_split ON segments(recording_id, split_of);
"#;

/// Phase 02/03 wrote provisional status strings before the phase 04/05 contract froze the
/// real state machine (discovered/probing/.../done/failed). Map any that survived.
const V3: &str = r#"
UPDATE recordings SET status = 'discovered' WHERE status = 'pending';
UPDATE recordings SET status = 'diarizing' WHERE status = 'transcribed';
UPDATE recordings SET status = 'done' WHERE status = 'diarized';
"#;

/// Phase 07 GPU OOM fallback (decision #19): sticky per-recording "whisper OOM'd on the gpu
/// here, use cpu" flag, read back by the pipeline on every run so it survives restarts.
const V4: &str = r#"
ALTER TABLE recordings ADD COLUMN force_cpu INTEGER NOT NULL DEFAULT 0;
"#;
