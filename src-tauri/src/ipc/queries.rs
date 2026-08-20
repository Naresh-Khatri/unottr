//! Plain functions over a rusqlite `Connection` — the actual SQL/data layer, factored out
//! of the `#[tauri::command]` wrappers so it's testable without a running app.

use std::path::Path;

use rusqlite::{Connection, OptionalExtension, Row, named_params, params};
use unottr_core::model::ModelStore;
use unottr_core::{Error, Paths, Result};

use super::types::{
    DiskUsage, ModelInfo, Recording, RecordingDetail, RecordingFilter, RecordingSort,
    RecordingSummary, SearchHit, Segment, Settings, SortBy, SortDir, Speaker, Status,
    WatchFolder, Word,
};

pub fn list_recordings(
    conn: &Connection,
    filter: &RecordingFilter,
    sort: &RecordingSort,
) -> Result<Vec<RecordingSummary>> {
    let status = filter.status.map(Status::as_str);
    let available = filter.available.map(i64::from);
    let like = filter.query.as_ref().map(|q| format!("%{q}%"));

    // no basename() in sqlite; ordering by path matches filename order for a flat tree
    let order = match (sort.by, sort.dir) {
        (SortBy::RecordedAt, SortDir::Asc) => "r.recorded_at ASC",
        (SortBy::RecordedAt, SortDir::Desc) => "r.recorded_at DESC",
        (SortBy::DurationMs, SortDir::Asc) => "r.duration_ms ASC",
        (SortBy::DurationMs, SortDir::Desc) => "r.duration_ms DESC",
        (SortBy::Filename, SortDir::Asc) => "r.path ASC",
        (SortBy::Filename, SortDir::Desc) => "r.path DESC",
    };

    let sql = format!(
        "SELECT r.id, r.path, r.recorded_at, r.duration_ms, r.status, r.stage_detail, r.error,
                r.available, (SELECT COUNT(*) FROM speakers sp WHERE sp.recording_id = r.id)
         FROM recordings r
         WHERE (:status IS NULL OR r.status = :status)
           AND (:available IS NULL OR r.available = :available)
           AND (:query IS NULL OR r.path LIKE :query)
         ORDER BY {order}"
    );

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(
        named_params! { ":status": status, ":available": available, ":query": like },
        row_to_summary,
    )?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn get_recording(conn: &Connection, id: i64) -> Result<Option<RecordingDetail>> {
    let recording = conn
        .query_row(
            "SELECT r.id, r.path, r.container, r.recorded_at, r.duration_ms, r.status,
                    r.stage_detail, r.error, r.available,
                    (SELECT COUNT(*) FROM speakers sp WHERE sp.recording_id = r.id)
             FROM recordings r WHERE r.id = ?1",
            [id],
            row_to_recording,
        )
        .optional()?;
    let Some(recording) = recording else {
        return Ok(None);
    };

    let mut seg_stmt = conn.prepare(
        "SELECT id, chunk_idx, start_ms, end_ms, text, words, speaker_id, split_of
         FROM segments WHERE recording_id = ?1 ORDER BY start_ms, id",
    )?;
    let segments = seg_stmt
        .query_map([id], row_to_segment)?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut sp_stmt = conn.prepare(
        "SELECT id, recording_id, label, display_name FROM speakers
         WHERE recording_id = ?1 ORDER BY label",
    )?;
    let speakers = sp_stmt
        .query_map([id], row_to_speaker)?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(Some(RecordingDetail { recording, segments, speakers }))
}

pub fn recording_path(conn: &Connection, id: i64) -> Result<String> {
    Ok(conn.query_row("SELECT path FROM recordings WHERE id = ?1", [id], |r| r.get(0))?)
}

pub fn search(conn: &Connection, query: &str, limit: i64) -> Result<Vec<SearchHit>> {
    // whole query as one phrase — keeps arbitrary user input out of fts5's query syntax
    let phrase = format!("\"{}\"", query.replace('"', "\"\""));
    let mut stmt = conn.prepare(
        "SELECT s.recording_id, r.path, s.id, s.start_ms,
                snippet(segments_fts, 0, '<b>', '</b>', '…', 8)
         FROM segments_fts
         JOIN segments s ON s.id = segments_fts.rowid
         JOIN recordings r ON r.id = s.recording_id
         WHERE segments_fts MATCH ?1
         ORDER BY rank
         LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![phrase, limit], |row| {
        let path: String = row.get(1)?;
        Ok(SearchHit {
            recording_id: row.get(0)?,
            filename: filename(&path),
            segment_id: row.get(2)?,
            start_ms: row.get(3)?,
            snippet: row.get(4)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn rename_speaker(conn: &Connection, speaker_id: i64, name: &str) -> Result<()> {
    let name = (!name.is_empty()).then_some(name);
    let changed = conn.execute(
        "UPDATE speakers SET display_name = ?1 WHERE id = ?2",
        params![name, speaker_id],
    )?;
    if changed == 0 {
        return Err(Error::Db(rusqlite::Error::QueryReturnedNoRows));
    }
    Ok(())
}

/// Resets a failed row so the caller can `enqueue` it; `false` means it wasn't `failed` (a
/// stale/duplicate click), and the caller must not enqueue.
pub fn retry_job(conn: &Connection, recording_id: i64) -> Result<bool> {
    unottr_core::db::recordings::reset_for_retry(conn, recording_id)
}

pub fn add_watch_folder(conn: &Connection, path: &str) -> Result<WatchFolder> {
    // idempotent: re-adding a known folder just re-enables it
    Ok(conn.query_row(
        "INSERT INTO watch_folders (path) VALUES (?1)
         ON CONFLICT(path) DO UPDATE SET enabled = 1
         RETURNING id, path, track_rule, enabled",
        [path],
        row_to_watch_folder,
    )?)
}

pub fn remove_watch_folder(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM watch_folders WHERE id = ?1", [id])?;
    Ok(())
}

pub fn list_watch_folders(conn: &Connection) -> Result<Vec<WatchFolder>> {
    let mut stmt =
        conn.prepare("SELECT id, path, track_rule, enabled FROM watch_folders ORDER BY path")?;
    let rows = stmt.query_map([], row_to_watch_folder)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn get_settings(conn: &Connection, tray_available: bool) -> Result<Settings> {
    let s = unottr_core::db::settings::load(conn)?;
    // cheap enough to run every call (two `-version` spawns): this is only hit on settings
    // screen loads/saves, never per-recording
    let ffmpeg_ok = unottr_core::media::FfmpegCli::from_settings(
        s.ffmpeg_path.as_deref(),
        s.ffprobe_path.as_deref(),
    )
    .check()
    .is_ok();
    Ok(Settings {
        model_tier: s.model_tier,
        language: s.language,
        device: s.device,
        diarize_threshold: s.diarize_threshold,
        ffmpeg_path: s.ffmpeg_path,
        ffprobe_path: s.ffprobe_path,
        cache_dir: s.cache_dir,
        autostart: s.autostart,
        close_to_tray: s.close_to_tray,
        tray_available,
        first_run_complete: unottr_core::db::settings::get_raw(conn, "first_run_complete")?
            .is_some_and(|v| v == "1"),
        ffmpeg_ok,
    })
}

/// Stores one key/value pair and returns the reloaded settings. Validation of `key`/`value`
/// is the caller's job (`commands::set_setting`) — this just persists what it's given.
pub fn set_setting(conn: &Connection, key: &str, value: &str, tray_available: bool) -> Result<Settings> {
    unottr_core::db::settings::set_raw(conn, key, value)?;
    get_settings(conn, tray_available)
}

/// `turbo`/`medium`/`small` only — `base.en` stays cli-only (see transcribe::model doc
/// comment), so it's never offered in the settings screen's picker.
pub fn list_models(store: &ModelStore) -> Vec<ModelInfo> {
    unottr_core::transcribe::model::MODELS
        .iter()
        .filter(|m| m.name != "base.en")
        .map(|m| ModelInfo {
            tier: unottr_core::db::settings::model_name_to_tier(m.name).to_string(),
            name: m.name.to_string(),
            size: m.size,
            downloaded: store.is_present(m),
        })
        .collect()
}

pub fn disk_usage(paths: &Paths) -> DiskUsage {
    DiskUsage {
        models_bytes: dir_size(&paths.models_dir()),
        cache_bytes: dir_size(&paths.pcm_cache_dir()),
    }
}

/// Non-recursive on purpose — models/pcm are both flat directories, never nested.
fn dir_size(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum()
}

fn filename(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|f| f.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

// Probe.has_video isn't persisted (phase 00 schema has no column for it), so this is a
// stand-in derived from the extension until phase 04 stores the real probe result.
const VIDEO_EXTS: &[&str] = &["mp4", "mkv", "mov", "webm", "avi", "m4v", "ts", "flv", "wmv"];

fn has_video(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| VIDEO_EXTS.contains(&e.to_lowercase().as_str()))
}

fn parse_words(raw: Option<String>) -> Vec<Word> {
    raw.filter(|s| !s.is_empty())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn row_to_summary(row: &Row) -> rusqlite::Result<RecordingSummary> {
    let path: String = row.get(1)?;
    let status_raw: String = row.get(4)?;
    Ok(RecordingSummary {
        filename: filename(&path),
        has_video: has_video(&path),
        id: row.get(0)?,
        recorded_at: row.get(2)?,
        duration_ms: row.get(3)?,
        status: Status::parse_lenient(&status_raw),
        stage_detail: row.get(5)?,
        error: row.get(6)?,
        available: row.get::<_, i64>(7)? != 0,
        speaker_count: row.get(8)?,
        path,
    })
}

fn row_to_recording(row: &Row) -> rusqlite::Result<Recording> {
    let path: String = row.get(1)?;
    let status_raw: String = row.get(5)?;
    let summary = RecordingSummary {
        filename: filename(&path),
        has_video: has_video(&path),
        id: row.get(0)?,
        recorded_at: row.get(3)?,
        duration_ms: row.get(4)?,
        status: Status::parse_lenient(&status_raw),
        stage_detail: row.get(6)?,
        error: row.get(7)?,
        available: row.get::<_, i64>(8)? != 0,
        speaker_count: row.get(9)?,
        path,
    };
    Ok(Recording { summary, container: row.get(2)? })
}

fn row_to_segment(row: &Row) -> rusqlite::Result<Segment> {
    Ok(Segment {
        id: row.get(0)?,
        chunk_idx: row.get(1)?,
        start_ms: row.get(2)?,
        end_ms: row.get(3)?,
        text: row.get(4)?,
        words: parse_words(row.get(5)?),
        speaker_id: row.get(6)?,
        split_of: row.get(7)?,
    })
}

fn row_to_speaker(row: &Row) -> rusqlite::Result<Speaker> {
    Ok(Speaker {
        id: row.get(0)?,
        recording_id: row.get(1)?,
        label: row.get(2)?,
        display_name: row.get(3)?,
    })
}

fn row_to_watch_folder(row: &Row) -> rusqlite::Result<WatchFolder> {
    Ok(WatchFolder {
        id: row.get(0)?,
        path: row.get(1)?,
        track_rule: row.get(2)?,
        enabled: row.get::<_, i64>(3)? != 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use unottr_core::Database;

    fn seeded_db() -> (tempfile::TempDir, Database) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path().join("test.db")).unwrap();
        let conn = db.connect().unwrap();
        let seed = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../docs/fixtures/seed.sql"
        ))
        .unwrap();
        conn.execute_batch(&seed).unwrap();
        (dir, db)
    }

    #[test]
    fn list_recordings_filters_by_status_and_availability() {
        let (_d, db) = seeded_db();
        let conn = db.connect().unwrap();

        let done = list_recordings(
            &conn,
            &RecordingFilter { status: Some(Status::Done), ..Default::default() },
            &RecordingSort::default(),
        )
        .unwrap();
        assert_eq!(done.iter().map(|r| r.id).collect::<Vec<_>>(), vec![9001]);

        let unavailable = list_recordings(
            &conn,
            &RecordingFilter { available: Some(false), ..Default::default() },
            &RecordingSort::default(),
        )
        .unwrap();
        assert_eq!(unavailable.iter().map(|r| r.id).collect::<Vec<_>>(), vec![9003]);
    }

    #[test]
    fn list_recordings_sorts_by_duration() {
        let (_d, db) = seeded_db();
        let conn = db.connect().unwrap();

        let asc = list_recordings(
            &conn,
            &RecordingFilter::default(),
            &RecordingSort { by: SortBy::DurationMs, dir: SortDir::Asc },
        )
        .unwrap();
        // 9003 has NULL duration_ms; sqlite sorts NULLs first ascending
        assert_eq!(asc.iter().map(|r| r.id).collect::<Vec<_>>(), vec![9003, 9002, 9001]);
    }

    #[test]
    fn list_recordings_computes_speaker_count_and_video() {
        let (_d, db) = seeded_db();
        let conn = db.connect().unwrap();
        let all = list_recordings(&conn, &RecordingFilter::default(), &RecordingSort::default())
            .unwrap();
        let r9001 = all.iter().find(|r| r.id == 9001).unwrap();
        assert_eq!(r9001.speaker_count, 2);
        assert!(r9001.has_video);
        assert_eq!(r9001.filename, "2025-10-06 roadmap-review.mp4");
    }

    #[test]
    fn get_recording_returns_parsed_words_and_speakers() {
        let (_d, db) = seeded_db();
        let conn = db.connect().unwrap();
        let detail = get_recording(&conn, 9001).unwrap().unwrap();

        assert_eq!(detail.recording.summary.id, 9001);
        assert_eq!(detail.recording.container.as_deref(), Some("mov,mp4,m4a"));
        assert_eq!(detail.speakers.len(), 2);
        assert_eq!(detail.segments.len(), 4);

        let first = &detail.segments[0];
        assert_eq!(first.words.len(), 2);
        assert_eq!(first.words[0].text, "Yeah,");
        assert_eq!(first.speaker_id, Some(9101));

        // unattributed segment renders null, not guessed
        let crosstalk = detail.segments.iter().find(|s| s.text == "(crosstalk)").unwrap();
        assert_eq!(crosstalk.speaker_id, None);
        assert!(crosstalk.words.is_empty());
    }

    #[test]
    fn get_recording_missing_id_is_none() {
        let (_d, db) = seeded_db();
        let conn = db.connect().unwrap();
        assert!(get_recording(&conn, 424242).unwrap().is_none());
    }

    #[test]
    fn search_finds_a_seeded_phrase_with_a_snippet() {
        let (_d, db) = seeded_db();
        let conn = db.connect().unwrap();
        let hits = search(&conn, "roadmap", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].recording_id, 9001);
        assert!(hits[0].snippet.contains("<b>roadmap</b>"), "{}", hits[0].snippet);
    }

    #[test]
    fn rename_speaker_round_trips_and_empty_clears() {
        let (_d, db) = seeded_db();
        let conn = db.connect().unwrap();

        rename_speaker(&conn, 9102, "Dana").unwrap();
        let detail = get_recording(&conn, 9001).unwrap().unwrap();
        let dana = detail.speakers.iter().find(|s| s.id == 9102).unwrap();
        assert_eq!(dana.display_name.as_deref(), Some("Dana"));

        rename_speaker(&conn, 9101, "").unwrap();
        let detail = get_recording(&conn, 9001).unwrap().unwrap();
        let cleared = detail.speakers.iter().find(|s| s.id == 9101).unwrap();
        assert_eq!(cleared.display_name, None);
    }

    #[test]
    fn watch_folders_add_list_remove() {
        let (_d, db) = seeded_db();
        let conn = db.connect().unwrap();

        let folder = add_watch_folder(&conn, "/home/naresh/meetings").unwrap();
        assert_eq!(folder.track_rule, "auto");
        assert!(folder.enabled);

        // adding the same path again is idempotent, not an error
        let again = add_watch_folder(&conn, "/home/naresh/meetings").unwrap();
        assert_eq!(again.id, folder.id);

        let all = list_watch_folders(&conn).unwrap();
        assert_eq!(all.len(), 1);

        remove_watch_folder(&conn, folder.id).unwrap();
        assert!(list_watch_folders(&conn).unwrap().is_empty());
    }

    #[test]
    fn settings_round_trip_through_the_wire_type() {
        let (_d, db) = seeded_db();
        let conn = db.connect().unwrap();

        let defaults = get_settings(&conn, true).unwrap();
        assert_eq!(defaults.model_tier, "auto");
        assert!(defaults.tray_available);

        let updated = set_setting(&conn, "model_tier", "medium", false).unwrap();
        assert_eq!(updated.model_tier, "medium");
        assert!(!updated.tray_available, "tray_available reflects the caller's flag, not storage");

        // re-reading confirms it actually persisted, not just echoed back
        assert_eq!(get_settings(&conn, false).unwrap().model_tier, "medium");
    }

    #[test]
    fn list_models_reports_the_three_settings_tiers_only() {
        let dir = tempfile::tempdir().unwrap();
        let store = ModelStore::new(dir.path());
        let models = list_models(&store);
        let tiers: Vec<_> = models.iter().map(|m| m.tier.as_str()).collect();
        assert_eq!(tiers, vec!["turbo", "medium", "small"]);
        assert!(models.iter().all(|m| !m.downloaded), "nothing downloaded into an empty dir");
    }
}
