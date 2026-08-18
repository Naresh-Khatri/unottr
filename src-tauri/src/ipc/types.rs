//! Wire types for the frozen IPC contract (docs/plan/05-ipc-contract.md).
//! Field names are snake_case on purpose — mirrors src/ipc/types.ts exactly, no remapping.

use serde::{Deserialize, Serialize};

// Same shape whisper writes into segments.words; reuse rather than duplicate.
pub use unottr_core::transcribe::Word;

/// UI-facing status. Phase 04 owns the real state machine; legacy/CLI-only strings that
/// predate it (e.g. "pending") don't fit this set, see `Status::parse_lenient`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Discovered,
    Probing,
    Extracting,
    Transcribing,
    Diarizing,
    Merging,
    Done,
    Failed,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Discovered => "discovered",
            Status::Probing => "probing",
            Status::Extracting => "extracting",
            Status::Transcribing => "transcribing",
            Status::Diarizing => "diarizing",
            Status::Merging => "merging",
            Status::Done => "done",
            Status::Failed => "failed",
        }
    }

    /// Anything not in the frozen set (legacy CLI values like "pending"/"transcribed") maps
    /// to `Discovered` rather than failing to deserialize the whole row.
    pub fn parse_lenient(raw: &str) -> Self {
        match raw {
            "discovered" => Status::Discovered,
            "probing" => Status::Probing,
            "extracting" => Status::Extracting,
            "transcribing" => Status::Transcribing,
            "diarizing" => Status::Diarizing,
            "merging" => Status::Merging,
            "done" => Status::Done,
            "failed" => Status::Failed,
            other => {
                tracing::warn!(status = other, "unrecognized recording status; treating as discovered");
                Status::Discovered
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Segment {
    pub id: i64,
    pub chunk_idx: i64,
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    pub words: Vec<Word>,
    pub speaker_id: Option<i64>,
    pub split_of: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Speaker {
    pub id: i64,
    pub recording_id: i64,
    pub label: String,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecordingSummary {
    pub id: i64,
    pub path: String,
    pub filename: String,
    pub recorded_at: Option<i64>,
    pub duration_ms: Option<i64>,
    pub status: Status,
    pub stage_detail: Option<String>,
    pub error: Option<String>,
    pub speaker_count: i64,
    pub available: bool,
    pub has_video: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Recording {
    #[serde(flatten)]
    pub summary: RecordingSummary,
    pub container: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecordingDetail {
    pub recording: Recording,
    pub segments: Vec<Segment>,
    pub speakers: Vec<Speaker>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub recording_id: i64,
    pub filename: String,
    pub segment_id: i64,
    pub start_ms: i64,
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct WatchFolder {
    pub id: i64,
    pub path: String,
    pub track_rule: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct RecordingFilter {
    pub status: Option<Status>,
    pub available: Option<bool>,
    /// Substring match against the recording path (there's no separate title/name column).
    pub query: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SortBy {
    RecordedAt,
    DurationMs,
    Filename,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SortDir {
    Asc,
    Desc,
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct RecordingSort {
    pub by: SortBy,
    pub dir: SortDir,
}

impl Default for RecordingSort {
    fn default() -> Self {
        Self { by: SortBy::RecordedAt, dir: SortDir::Desc }
    }
}
