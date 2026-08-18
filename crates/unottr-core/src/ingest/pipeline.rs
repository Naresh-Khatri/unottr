//! One recording, start to finish. Always runs the full sequence regardless of which
//! non-terminal status it entered at — see the reconciliation note in `reconcile.rs` for why
//! that is simpler and just as correct as resuming exactly at the failed stage.

use std::path::PathBuf;

use crate::cancel::CancelToken;
use crate::db::recordings::{self, Status};
use crate::diarize;
use crate::error::Result;
use crate::media::{MediaBackend, Selection, TrackRule};
use crate::model::ModelStore;
use crate::paths::Paths;
use crate::transcribe::{self, Device, Options};
use crate::{Database, ModelSpec};

#[derive(Debug, Clone)]
pub struct PipelineConfig {
    pub device: Device,
    pub threads: Option<i32>,
    pub language: Option<String>,
    /// Model name from the registries; `None` picks the device-appropriate default.
    pub whisper_model: Option<String>,
    pub embedding_model: Option<String>,
    pub diarize_threshold: Option<f32>,
    pub diarize_speakers: Option<u32>,
    /// Fetch whisper/segmentation/embedding models if missing rather than erroring. VAD is
    /// always auto-fetched regardless — small enough that asking first would be theatre
    /// (mirrors the phase 02/03 cli's `--download` gating).
    pub download_models: bool,
}

impl Default for PipelineConfig {
    fn default() -> Self {
        Self {
            device: Device::Auto,
            threads: None,
            language: None,
            whisper_model: None,
            embedding_model: None,
            diarize_threshold: None,
            diarize_speakers: None,
            download_models: false,
        }
    }
}

/// Bundles what every stage needs so `process_recording` stays under clippy's argument-count
/// lint instead of an `#[allow]`.
#[derive(Clone, Copy)]
pub struct PipelineCtx<'a> {
    pub db: &'a Database,
    pub paths: &'a Paths,
    pub backend: &'a dyn MediaBackend,
    pub store: &'a ModelStore,
    pub cfg: &'a PipelineConfig,
}

pub fn process_recording(
    ctx: &PipelineCtx,
    id: i64,
    cancel: &CancelToken,
    on_progress: &dyn Fn(Status, f32),
) -> Result<()> {
    let PipelineCtx { db, paths, backend, store, cfg } = *ctx;
    cancel.check()?;
    let path = {
        let conn = db.connect()?;
        recordings::path_of(&conn, id)?.ok_or_else(|| crate::Error::Probe {
            path: PathBuf::new(),
            reason: format!("recording {id} vanished from the database"),
        })?
    };

    // --- probing ---
    {
        let conn = db.connect()?;
        recordings::set_status(&conn, id, Status::Probing, None)?;
    }
    on_progress(Status::Probing, 0.0);
    let probe = backend.probe(&path)?;
    {
        let conn = db.connect()?;
        recordings::set_probe_result(&conn, id, &probe.container, probe.duration_ms)?;
    }
    on_progress(Status::Probing, 1.0);

    let rule = owning_track_rule(db, &path)?;
    let choice = crate::media::select(&probe, &rule)?;

    // --- extracting ---
    {
        let conn = db.connect()?;
        recordings::set_status(&conn, id, Status::Extracting, None)?;
    }
    let cache = paths.pcm_cache_dir();
    let extract_track = |audio_index: u32, cancel: &CancelToken| -> Result<PathBuf> {
        let out = transcribe::pcm_path_for(&cache, &path, audio_index);
        // an existing file is a finished one (mirrors the cli's cache-by-existence and
        // ffmpeg::discard on failure) — makes a retry's extract stage a no-op
        if out.exists() {
            return Ok(out);
        }
        backend.extract_pcm(&path, audio_index, &out, &|f| on_progress(Status::Extracting, f), cancel)?;
        Ok(out)
    };
    let (main_pcm, mic_pcm) = match choice.selection {
        Selection::Blind { stream } => (extract_track(stream, cancel)?, None),
        Selection::MicDesktop { mic, desktop } => {
            let (mic_p, desktop_p) = (extract_track(mic, cancel)?, extract_track(desktop, cancel)?);
            let stem = path.file_stem().unwrap_or_default().to_string_lossy();
            let mix = cache.join(format!("{stem}.mix.pcm"));
            if !mix.exists() {
                crate::media::mix_pcm(&[&mic_p, &desktop_p], &mix)?;
            }
            (mix, Some(mic_p))
        }
    };
    on_progress(Status::Extracting, 1.0);

    // --- transcribing (checkpointed inside transcribe::run) ---
    let device = transcribe::resolve(cfg.device);
    let whisper_spec = match &cfg.whisper_model {
        Some(name) => transcribe::model::find(name).ok_or_else(|| crate::Error::ModelMissing {
            name: name.clone(),
        })?,
        None => transcribe::model::default_for(device.is_gpu()),
    };
    let whisper_model = fetch_model(store, whisper_spec, cfg.download_models, cancel)?;
    let vad_model = fetch_model(store, &transcribe::VAD, true, cancel)?;

    let job = transcribe::Job {
        recording_id: id,
        pcm: main_pcm.clone(),
        model: whisper_model,
        vad_model: vad_model.clone(),
        device: cfg.device,
        options: Options {
            language: cfg.language.clone(),
            threads: cfg.threads.unwrap_or_else(transcribe::engine::default_threads),
            translate: false,
        },
    };
    transcribe::run(db, &job, &|f| on_progress(Status::Transcribing, f), cancel)?;

    // --- diarizing ---
    // explicit, defensive: transcribe::run's own status write is skipped on the zero-chunk
    // early-return path (an all-silence recording), so this is not always redundant.
    {
        let conn = db.connect()?;
        recordings::set_status(&conn, id, Status::Diarizing, None)?;
    }
    let embedding_spec = match &cfg.embedding_model {
        Some(name) => diarize::find_embedding(name).ok_or_else(|| crate::Error::ModelMissing {
            name: name.clone(),
        })?,
        None => diarize::default_embedding(),
    };
    let segmentation = fetch_model(store, &diarize::SEGMENTATION, cfg.download_models, cancel)?;
    let embedding = fetch_model(store, embedding_spec, cfg.download_models, cancel)?;

    let job = diarize::Job {
        recording_id: id,
        pcm: main_pcm,
        mic_pcm,
        segmentation,
        embedding,
        vad_model,
        config: diarize::Config {
            threshold: cfg.diarize_threshold.unwrap_or(diarize::DEFAULT_THRESHOLD),
            speakers: cfg.diarize_speakers,
        },
    };
    diarize::run(db, &job, &|f| on_progress(Status::Diarizing, f), cancel)?;
    // diarize::run's persist() already wrote status = 'done' in the same transaction as the
    // merge; nothing left to do here.
    Ok(())
}

/// Small models (vad/segmentation) or a caller that opted into downloads: fetch if missing.
/// Otherwise a missing model is a hard error naming the model to fetch.
fn fetch_model(store: &ModelStore, spec: &ModelSpec, download: bool, cancel: &CancelToken) -> Result<PathBuf> {
    if download || store.is_present(spec) {
        store.ensure(spec, &|_| {}, cancel)
    } else {
        store.locate(spec)
    }
}

/// The watch folder a path lives directly under (watches are non-recursive), if any, gives
/// its configured track rule. Files reached other ways (backfill of an arbitrary folder,
/// the standalone cli) fall back to `Auto`.
fn owning_track_rule(db: &Database, path: &std::path::Path) -> Result<TrackRule> {
    let Some(parent) = path.parent() else {
        return Ok(TrackRule::Auto);
    };
    let conn = db.connect()?;
    Ok(crate::db::watch_folders::find_by_path(&conn, parent)?.map_or(TrackRule::Auto, |wf| wf.rule()))
}
