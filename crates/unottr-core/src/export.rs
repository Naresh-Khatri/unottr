//! Rendering a recording's transcript to portable text formats. Pure serialization — no
//! disk writes here; the caller hands the string to a save dialog (06-settings-and-shell.md
//! decision #17: export is the escape hatch, no automatic sidecar files).

use std::fmt::Write as _;

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

use crate::error::{Error, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Txt,
    Json,
    Srt,
    Vtt,
}

impl Format {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "txt" => Some(Format::Txt),
            "json" => Some(Format::Json),
            "srt" => Some(Format::Srt),
            "vtt" => Some(Format::Vtt),
            _ => None,
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            Format::Txt => "txt",
            Format::Json => "json",
            Format::Srt => "srt",
            Format::Vtt => "vtt",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportSegment {
    pub start_ms: i64,
    pub end_ms: i64,
    pub speaker: Option<String>,
    pub text: String,
}

/// One recording's exportable transcript: enough to render any of the four formats without
/// going back to the database.
#[derive(Debug, Clone, Serialize)]
pub struct Transcript {
    pub filename: String,
    pub segments: Vec<ExportSegment>,
}

/// Loads a recording's segments joined to a display-ready speaker label — the renamed
/// `display_name` if the user set one, else the auto-assigned `"Speaker N"` label, else
/// `None` for an unattributed segment (never guessed, matches the transcript view).
pub fn load(conn: &Connection, recording_id: i64) -> Result<Transcript> {
    let path: Option<String> = conn
        .query_row("SELECT path FROM recordings WHERE id = ?1", [recording_id], |r| r.get(0))
        .optional()?;
    let path = path.ok_or(Error::Db(rusqlite::Error::QueryReturnedNoRows))?;
    let filename = std::path::Path::new(&path)
        .file_name()
        .map(|f| f.to_string_lossy().into_owned())
        .unwrap_or(path);

    let mut stmt = conn.prepare(
        "SELECT s.start_ms, s.end_ms, s.text, COALESCE(sp.display_name, sp.label)
         FROM segments s
         LEFT JOIN speakers sp ON sp.id = s.speaker_id
         WHERE s.recording_id = ?1
         ORDER BY s.start_ms, s.id",
    )?;
    let segments = stmt
        .query_map([recording_id], |row| {
            Ok(ExportSegment {
                start_ms: row.get(0)?,
                end_ms: row.get(1)?,
                text: row.get(2)?,
                speaker: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(Transcript { filename, segments })
}

pub fn render(format: Format, transcript: &Transcript) -> String {
    match format {
        Format::Txt => render_txt(transcript),
        Format::Json => {
            serde_json::to_string_pretty(transcript).expect("Transcript always serializes")
        }
        Format::Srt => render_subtitles(transcript, Subtitle::Srt),
        Format::Vtt => render_subtitles(transcript, Subtitle::Vtt),
    }
}

fn render_txt(t: &Transcript) -> String {
    let mut out = String::new();
    for seg in &t.segments {
        let ts = hms(seg.start_ms);
        match &seg.speaker {
            Some(name) => writeln!(out, "[{ts}] {name}: {}", seg.text).unwrap(),
            None => writeln!(out, "[{ts}] {}", seg.text).unwrap(),
        }
    }
    out
}

#[derive(Clone, Copy)]
enum Subtitle {
    Srt,
    Vtt,
}

fn render_subtitles(t: &Transcript, kind: Subtitle) -> String {
    let mut out = String::new();
    if let Subtitle::Vtt = kind {
        out.push_str("WEBVTT\n\n");
    }
    for (i, seg) in t.segments.iter().enumerate() {
        let (start, end) = match kind {
            Subtitle::Srt => (srt_ts(seg.start_ms), srt_ts(seg.end_ms)),
            Subtitle::Vtt => (vtt_ts(seg.start_ms), vtt_ts(seg.end_ms)),
        };
        writeln!(out, "{}", i + 1).unwrap();
        writeln!(out, "{start} --> {end}").unwrap();
        match &seg.speaker {
            Some(name) => writeln!(out, "{name}: {}", seg.text).unwrap(),
            None => writeln!(out, "{}", seg.text).unwrap(),
        }
        out.push('\n');
    }
    out
}

fn hms(ms: i64) -> String {
    let total = ms.max(0) / 1000;
    format!("{:02}:{:02}:{:02}", total / 3600, (total / 60) % 60, total % 60)
}

/// `HH:MM:SS,mmm` — SRT uses a comma between seconds and milliseconds.
fn srt_ts(ms: i64) -> String {
    format!("{},{:03}", hms(ms), ms.max(0) % 1000)
}

/// `HH:MM:SS.mmm` — WebVTT uses a period, same otherwise.
fn vtt_ts(ms: i64) -> String {
    format!("{}.{:03}", hms(ms), ms.max(0) % 1000)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Database;

    fn temp_db() -> (tempfile::TempDir, Database) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path().join("t.db")).unwrap();
        (dir, db)
    }

    fn seed(conn: &Connection) {
        conn.execute_batch(
            "INSERT INTO recordings (id, path, fp_size, fp_head, fp_tail, status, created_at, updated_at)
             VALUES (1, '/rec/2025-10-06 roadmap.mp4', 1, x'00', x'00', 'done', 0, 0);
             INSERT INTO speakers (id, recording_id, label, display_name)
             VALUES (1, 1, 'Speaker 1', 'Dana'), (2, 1, 'Speaker 2', NULL);
             INSERT INTO segments (id, recording_id, chunk_idx, start_ms, end_ms, text, speaker_id)
             VALUES
                (1, 1, 0, 1360, 4200, 'Let''s start with the roadmap.', 1),
                (2, 1, 0, 4200, 6000, 'Sounds good.', 2),
                (3, 1, 0, 6000, 6500, '(crosstalk)', NULL);",
        )
        .unwrap();
    }

    #[test]
    fn srt_timestamp_format_is_exact() {
        // 1h 1m 1s 200ms
        assert_eq!(srt_ts(3_661_200), "01:01:01,200");
        assert_eq!(srt_ts(0), "00:00:00,000");
    }

    #[test]
    fn vtt_timestamp_format_is_exact() {
        assert_eq!(vtt_ts(3_661_200), "01:01:01.200");
        assert_eq!(vtt_ts(1360), "00:00:01.360");
    }

    #[test]
    fn format_parses_and_round_trips_extension() {
        for (s, ext) in [("txt", "txt"), ("json", "json"), ("srt", "srt"), ("vtt", "vtt")] {
            let f = Format::parse(s).unwrap();
            assert_eq!(f.extension(), ext);
        }
        assert!(Format::parse("docx").is_none());
    }

    #[test]
    fn load_joins_display_name_falls_back_to_label_and_leaves_unattributed_null() {
        let (_d, db) = temp_db();
        let conn = db.connect().unwrap();
        seed(&conn);

        let t = load(&conn, 1).unwrap();
        assert_eq!(t.filename, "2025-10-06 roadmap.mp4");
        assert_eq!(t.segments.len(), 3);
        assert_eq!(t.segments[0].speaker.as_deref(), Some("Dana"));
        assert_eq!(t.segments[1].speaker.as_deref(), Some("Speaker 2"));
        assert_eq!(t.segments[2].speaker, None);
    }

    #[test]
    fn load_missing_recording_errors() {
        let (_d, db) = temp_db();
        let conn = db.connect().unwrap();
        assert!(load(&conn, 404).is_err());
    }

    #[test]
    fn txt_render_prefixes_timestamp_and_speaker() {
        let (_d, db) = temp_db();
        let conn = db.connect().unwrap();
        seed(&conn);
        let out = render(Format::Txt, &load(&conn, 1).unwrap());
        assert!(out.contains("[00:00:01] Dana: Let's start with the roadmap."));
        assert!(out.contains("[00:00:06] (crosstalk)"), "unattributed segment must skip the speaker prefix");
    }

    #[test]
    fn json_render_is_valid_and_carries_every_field() {
        let (_d, db) = temp_db();
        let conn = db.connect().unwrap();
        seed(&conn);
        let out = render(Format::Json, &load(&conn, 1).unwrap());
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["filename"], "2025-10-06 roadmap.mp4");
        assert_eq!(parsed["segments"][0]["speaker"], "Dana");
        assert_eq!(parsed["segments"][2]["speaker"], serde_json::Value::Null);
    }

    #[test]
    fn srt_render_matches_the_spec_shape() {
        let (_d, db) = temp_db();
        let conn = db.connect().unwrap();
        seed(&conn);
        let out = render(Format::Srt, &load(&conn, 1).unwrap());
        let expected = "1\n\
             00:00:01,360 --> 00:00:04,200\n\
             Dana: Let's start with the roadmap.\n\
             \n\
             2\n\
             00:00:04,200 --> 00:00:06,000\n\
             Speaker 2: Sounds good.\n\
             \n\
             3\n\
             00:00:06,000 --> 00:00:06,500\n\
             (crosstalk)\n\
             \n";
        assert_eq!(out, expected);
    }

    #[test]
    fn vtt_render_starts_with_the_webvtt_header_and_uses_dot_timestamps() {
        let (_d, db) = temp_db();
        let conn = db.connect().unwrap();
        seed(&conn);
        let out = render(Format::Vtt, &load(&conn, 1).unwrap());
        assert!(out.starts_with("WEBVTT\n\n1\n00:00:01.360 --> 00:00:04.200\n"));
        assert!(!out.contains(','), "vtt must never use comma-separated milliseconds");
    }
}
