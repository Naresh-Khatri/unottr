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

#[derive(Debug, Clone, Serialize)]
pub struct ModelDownloadProgress {
    /// The tier name ("turbo"/"medium"/"small"), not the registry filename — matches what
    /// the settings screen's model picker already keys on.
    pub model: String,
    /// 0..1, not 0..100 — same convention as `JobProgress::pct`.
    pub pct: f32,
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

pub fn model_download_progress(app: &AppHandle, payload: ModelDownloadProgress) -> tauri::Result<()> {
    app.emit("model_download_progress", payload)
}
