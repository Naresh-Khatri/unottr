//! Typed `emit` helpers for the events in docs/plan/05-ipc-contract.md. Only the worker
//! (phase 04) calls these for real; nothing here fakes progress.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::types::Status;

#[derive(Debug, Clone, Serialize)]
pub struct JobProgress {
    pub recording_id: i64,
    pub stage: Status,
    /// 0..1, not 0..100.
    pub pct: f32,
}

#[derive(Debug, Clone, Serialize)]
pub struct JobDone {
    pub recording_id: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct JobFailed {
    pub recording_id: i64,
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecordingDiscovered {
    pub recording_id: i64,
}

pub fn job_progress(app: &AppHandle, payload: JobProgress) -> tauri::Result<()> {
    app.emit("job_progress", payload)
}

pub fn job_done(app: &AppHandle, payload: JobDone) -> tauri::Result<()> {
    app.emit("job_done", payload)
}

pub fn job_failed(app: &AppHandle, payload: JobFailed) -> tauri::Result<()> {
    app.emit("job_failed", payload)
}

pub fn recording_discovered(app: &AppHandle, payload: RecordingDiscovered) -> tauri::Result<()> {
    app.emit("recording_discovered", payload)
}
