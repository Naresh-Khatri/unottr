//! Typed accessors over the key/value `settings` table (phase 00 schema). Raw strings on
//! disk — parsing/validation lives here so callers (cli, tauri, tests) never touch the
//! table directly and can't disagree on what a key means.

use rusqlite::{Connection, OptionalExtension, params};

use crate::error::Result;
use crate::ingest::PipelineConfig;
use crate::transcribe::Device;

/// Key names, centralized so nothing hardcodes a typo-prone string more than once. Settings
/// stay free-form kv on disk (00-foundations.md) — this is just naming discipline.
pub mod keys {
    pub const MODEL_TIER: &str = "model_tier"; // "auto" | "turbo" | "medium" | "small"
    pub const LANGUAGE: &str = "language"; // "auto" | a whisper language code
    pub const DEVICE: &str = "device"; // "auto" | "gpu" | "cpu"
    pub const DIARIZE_THRESHOLD: &str = "diarize_threshold"; // f32, absent = engine default
    pub const FFMPEG_PATH: &str = "ffmpeg_path";
    pub const FFPROBE_PATH: &str = "ffprobe_path";
    pub const CACHE_DIR: &str = "cache_dir"; // overrides the pcm cache subdir only
    pub const AUTOSTART: &str = "autostart"; // "1" | "0"
    pub const CLOSE_TO_TRAY: &str = "close_to_tray"; // "1" | "0", default "1"
    pub const CLOSE_TO_TRAY_EXPLAINED: &str = "close_to_tray_explained";
}

/// `turbo`/`medium`/`small` are the three tiers the settings screen offers (06-settings.md);
/// `base.en` stays reachable only via the cli. `None` (including "auto") defers to
/// `transcribe::model::default_for`, which already picks the right size for the device.
pub fn tier_to_model_name(tier: &str) -> Option<&'static str> {
    match tier {
        "turbo" => Some("large-v3-turbo"),
        "medium" => Some("medium"),
        "small" => Some("small"),
        _ => None,
    }
}

pub fn model_name_to_tier(name: &str) -> &'static str {
    match name {
        "large-v3-turbo" => "turbo",
        "medium" => "medium",
        "small" => "small",
        _ => "auto",
    }
}

fn device_to_str(d: Device) -> &'static str {
    match d {
        Device::Auto => "auto",
        Device::Gpu => "gpu",
        Device::Cpu => "cpu",
    }
}

fn device_from_str(s: &str) -> Device {
    match s {
        "gpu" => Device::Gpu,
        "cpu" => Device::Cpu,
        _ => Device::Auto,
    }
}

/// Everything the settings screen shows and the core honours. Mirrors the wire `Settings`
/// type the tauri layer serializes straight through — kept here so the two can't drift.
#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
    pub model_tier: String,
    pub language: Option<String>,
    pub device: Device,
    pub diarize_threshold: Option<f32>,
    pub ffmpeg_path: Option<String>,
    pub ffprobe_path: Option<String>,
    pub cache_dir: Option<String>,
    pub autostart: bool,
    pub close_to_tray: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            model_tier: "auto".to_string(),
            language: None,
            device: Device::Auto,
            diarize_threshold: None,
            ffmpeg_path: None,
            ffprobe_path: None,
            cache_dir: None,
            autostart: false,
            close_to_tray: true,
        }
    }
}

pub fn get_raw(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0))
        .optional()?)
}

pub fn set_raw(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// A missing key just falls back to the type's default, so a brand-new db (or one where a
/// caller never set a particular key) reads as sensible defaults rather than erroring.
pub fn load(conn: &Connection) -> Result<Settings> {
    let mut s = Settings::default();
    if let Some(v) = get_raw(conn, keys::MODEL_TIER)? {
        s.model_tier = v;
    }
    s.language = get_raw(conn, keys::LANGUAGE)?.filter(|v| v != "auto" && !v.is_empty());
    if let Some(v) = get_raw(conn, keys::DEVICE)? {
        s.device = device_from_str(&v);
    }
    s.diarize_threshold = get_raw(conn, keys::DIARIZE_THRESHOLD)?.and_then(|v| v.parse().ok());
    s.ffmpeg_path = get_raw(conn, keys::FFMPEG_PATH)?.filter(|v| !v.is_empty());
    s.ffprobe_path = get_raw(conn, keys::FFPROBE_PATH)?.filter(|v| !v.is_empty());
    s.cache_dir = get_raw(conn, keys::CACHE_DIR)?.filter(|v| !v.is_empty());
    s.autostart = get_raw(conn, keys::AUTOSTART)?.as_deref() == Some("1");
    s.close_to_tray = get_raw(conn, keys::CLOSE_TO_TRAY)?.map(|v| v == "1").unwrap_or(true);
    Ok(s)
}

pub fn save(conn: &Connection, s: &Settings) -> Result<()> {
    set_raw(conn, keys::MODEL_TIER, &s.model_tier)?;
    set_raw(conn, keys::LANGUAGE, s.language.as_deref().unwrap_or("auto"))?;
    set_raw(conn, keys::DEVICE, device_to_str(s.device))?;
    if let Some(t) = s.diarize_threshold {
        set_raw(conn, keys::DIARIZE_THRESHOLD, &t.to_string())?;
    }
    set_raw(conn, keys::FFMPEG_PATH, s.ffmpeg_path.as_deref().unwrap_or(""))?;
    set_raw(conn, keys::FFPROBE_PATH, s.ffprobe_path.as_deref().unwrap_or(""))?;
    set_raw(conn, keys::CACHE_DIR, s.cache_dir.as_deref().unwrap_or(""))?;
    set_raw(conn, keys::AUTOSTART, if s.autostart { "1" } else { "0" })?;
    set_raw(conn, keys::CLOSE_TO_TRAY, if s.close_to_tray { "1" } else { "0" })?;
    Ok(())
}

pub fn close_to_tray_explained(conn: &Connection) -> Result<bool> {
    Ok(get_raw(conn, keys::CLOSE_TO_TRAY_EXPLAINED)?.as_deref() == Some("1"))
}

pub fn mark_close_to_tray_explained(conn: &Connection) -> Result<()> {
    set_raw(conn, keys::CLOSE_TO_TRAY_EXPLAINED, "1")
}

/// Builds the config the worker reads before each job (see `ingest::worker`). `threads`,
/// `embedding_model` and `diarize_speakers` have no settings-screen control yet, so they
/// stay at the pipeline's own defaults. `download_models` stays false here on purpose — the
/// tauri layer never silently downloads mid-job; that only happens via the explicit model
/// download command (06-settings-and-shell.md).
pub fn pipeline_config(conn: &Connection) -> Result<PipelineConfig> {
    let s = load(conn)?;
    Ok(PipelineConfig {
        device: s.device,
        whisper_model: tier_to_model_name(&s.model_tier).map(str::to_string),
        language: s.language,
        diarize_threshold: s.diarize_threshold,
        ..PipelineConfig::default()
    })
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

    #[test]
    fn defaults_when_nothing_is_set() {
        let (_d, db) = temp_db();
        let conn = db.connect().unwrap();
        assert_eq!(load(&conn).unwrap(), Settings::default());
    }

    #[test]
    fn round_trips_every_field() {
        let (_d, db) = temp_db();
        let conn = db.connect().unwrap();
        let s = Settings {
            model_tier: "small".to_string(),
            language: Some("en".to_string()),
            device: Device::Cpu,
            diarize_threshold: Some(0.42),
            ffmpeg_path: Some("/opt/ffmpeg".to_string()),
            ffprobe_path: Some("/opt/ffprobe".to_string()),
            cache_dir: Some("/mnt/cache".to_string()),
            autostart: true,
            close_to_tray: false,
        };
        save(&conn, &s).unwrap();
        assert_eq!(load(&conn).unwrap(), s);
    }

    #[test]
    fn auto_language_reads_back_as_none() {
        let (_d, db) = temp_db();
        let conn = db.connect().unwrap();
        set_raw(&conn, keys::LANGUAGE, "auto").unwrap();
        assert_eq!(load(&conn).unwrap().language, None);
    }

    #[test]
    fn pipeline_config_maps_tier_to_registry_name() {
        let (_d, db) = temp_db();
        let conn = db.connect().unwrap();

        // unset -> device-appropriate default (None lets the pipeline pick)
        assert_eq!(pipeline_config(&conn).unwrap().whisper_model, None);

        set_raw(&conn, keys::MODEL_TIER, "medium").unwrap();
        assert_eq!(pipeline_config(&conn).unwrap().whisper_model.as_deref(), Some("medium"));

        set_raw(&conn, keys::MODEL_TIER, "turbo").unwrap();
        assert_eq!(pipeline_config(&conn).unwrap().whisper_model.as_deref(), Some("large-v3-turbo"));
    }

    #[test]
    fn pipeline_config_carries_device_language_and_threshold() {
        let (_d, db) = temp_db();
        let conn = db.connect().unwrap();
        set_raw(&conn, keys::DEVICE, "cpu").unwrap();
        set_raw(&conn, keys::LANGUAGE, "fr").unwrap();
        set_raw(&conn, keys::DIARIZE_THRESHOLD, "0.7").unwrap();

        let cfg = pipeline_config(&conn).unwrap();
        assert_eq!(cfg.device, Device::Cpu);
        assert_eq!(cfg.language.as_deref(), Some("fr"));
        assert_eq!(cfg.diarize_threshold, Some(0.7));
        assert!(!cfg.download_models, "settings never trigger a silent download");
    }

    #[test]
    fn close_to_tray_hint_defaults_unexplained_and_marks_once() {
        let (_d, db) = temp_db();
        let conn = db.connect().unwrap();
        assert!(!close_to_tray_explained(&conn).unwrap());
        mark_close_to_tray_explained(&conn).unwrap();
        assert!(close_to_tray_explained(&conn).unwrap());
    }

    #[test]
    fn tier_name_mapping_round_trips() {
        for (tier, name) in [("turbo", "large-v3-turbo"), ("medium", "medium"), ("small", "small")] {
            assert_eq!(tier_to_model_name(tier), Some(name));
            assert_eq!(model_name_to_tier(name), tier);
        }
        assert_eq!(tier_to_model_name("auto"), None);
        assert_eq!(tier_to_model_name("bogus"), None);
    }
}
