use std::path::Path;

use serde::{Deserialize, Serialize};
use tracing::{info, warn};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use crate::cancel::CancelToken;
use crate::error::{Error, Result};

/// `large-v3-turbo` needs roughly this much to sit on the card. Below it, ggml would spill
/// and be slower than the cpu path.
const MIN_VRAM: u64 = 2 << 30;

/// What the user asked for. `Auto` is the only value that inspects the machine.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Device {
    #[default]
    Auto,
    Gpu,
    Cpu,
}

/// What we actually got. Settings and logs show this, not `Device`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Resolved {
    Gpu,
    Cpu,
}

impl Resolved {
    pub fn is_gpu(self) -> bool {
        self == Resolved::Gpu
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpuInfo {
    pub id: i32,
    pub name: String,
    pub free_bytes: u64,
    pub total_bytes: u64,
}

#[cfg(feature = "vulkan")]
pub fn gpus() -> Vec<GpuInfo> {
    whisper_rs::vulkan::list_devices()
        .into_iter()
        .map(|d| GpuInfo {
            id: d.id,
            name: d.name,
            free_bytes: d.vram.free as u64,
            total_bytes: d.vram.total as u64,
        })
        .collect()
}

#[cfg(not(feature = "vulkan"))]
pub fn gpus() -> Vec<GpuInfo> {
    Vec::new()
}

/// `Gpu` is taken at the user's word — if they forced it and there is no card, whisper
/// falls back on its own rather than failing.
pub fn resolve(device: Device) -> Resolved {
    match device {
        Device::Cpu => Resolved::Cpu,
        Device::Gpu => Resolved::Gpu,
        Device::Auto => {
            if gpus().iter().any(|g| g.free_bytes >= MIN_VRAM) {
                Resolved::Gpu
            } else {
                Resolved::Cpu
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct Options {
    /// `None` = let whisper detect. Detection runs on the first chunk, so a quiet opening
    /// can get it wrong; that is why the override exists.
    pub language: Option<String>,
    pub threads: i32,
    pub translate: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            language: None,
            threads: default_threads(),
            translate: false,
        }
    }
}

pub fn default_threads() -> i32 {
    std::thread::available_parallelism().map_or(4, |n| n.get() as i32)
}

/// One transcribed span of speech, timestamps relative to whatever samples were passed in.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Utterance {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
    pub words: Vec<Word>,
}

impl Utterance {
    /// Whisper times every chunk from zero; the db stores absolute times.
    pub fn shift(&mut self, ms: u64) {
        self.start_ms += ms;
        self.end_ms += ms;
        for w in &mut self.words {
            w.start_ms += ms;
            w.end_ms += ms;
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Word {
    pub text: String,
    pub start_ms: u64,
    pub end_ms: u64,
    /// Mean token probability across the pieces that make up the word.
    pub p: f32,
}

/// A loaded model. Expensive to build (seconds, plus VRAM), cheap to reuse — hold one for
/// the whole recording and call `run` per chunk.
pub struct Transcriber {
    ctx: WhisperContext,
    device: Resolved,
    opts: Options,
}

impl Transcriber {
    pub fn load(model: &Path, device: Device, opts: Options) -> Result<Self> {
        let device = resolve(device);
        let path = model.to_str().ok_or_else(|| Error::ModelMissing {
            name: model.display().to_string(),
        })?;

        let mut params = WhisperContextParameters::default();
        params.use_gpu(device.is_gpu());

        let ctx = WhisperContext::new_with_params(path, params).map_err(|e| {
            // bad magic, truncated file, unreadable -- all the same fix for the user
            warn!(model = %model.display(), "{e}");
            Error::ModelMissing {
                name: file_name(model),
            }
        })?;
        info!(?device, model = %model.display(), "model loaded");
        Ok(Self { ctx, device, opts })
    }

    pub fn device(&self) -> Resolved {
        self.device
    }

    /// Transcribe one chunk. Timestamps come back relative to `samples`; the caller adds
    /// the chunk offset.
    pub fn run(&self, samples: &[f32], cancel: &CancelToken) -> Result<Vec<Utterance>> {
        cancel.check()?;

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_n_threads(self.opts.threads);
        params.set_translate(self.opts.translate);
        params.set_language(self.opts.language.as_deref());
        params.set_token_timestamps(true);
        // each chunk decodes standalone: keeps a hallucination from seeding the next one,
        // and makes a resumed run byte-identical to an uninterrupted one
        params.set_no_context(true);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_print_special(false);

        // no abort callback: whisper-rs 0.16 builds its trampoline for the concrete closure
        // type but passes a `Box<dyn FnMut>` -> reads garbage -> every encode aborts (-6).
        // chunks are <= 30 s so the between-chunk `cancel.check()` is granular enough.

        let mut state = self
            .ctx
            .create_state()
            .map_err(|e| self.whisper_error(&e.to_string()))?;
        state
            .full(params, samples)
            .map_err(|e| self.whisper_error(&e.to_string()))?;

        let eot = self.ctx.token_eot();
        let mut out = Vec::new();
        for segment in state.as_iter() {
            let text = segment.to_str_lossy().unwrap_or_default().into_owned();
            if text.trim().is_empty() {
                continue;
            }

            let mut pieces = Vec::new();
            for i in 0..segment.n_tokens() {
                let Some(token) = segment.get_token(i) else {
                    continue;
                };
                if token.token_id() >= eot {
                    continue;
                }
                let Ok(piece) = token.to_str_lossy() else {
                    continue;
                };
                let data = token.token_data();
                pieces.push((
                    piece.into_owned(),
                    cs_to_ms(data.t0),
                    cs_to_ms(data.t1),
                    data.p,
                ));
            }

            out.push(Utterance {
                start_ms: cs_to_ms(segment.start_timestamp()),
                end_ms: cs_to_ms(segment.end_timestamp()),
                text: text.trim().to_string(),
                words: merge_words(pieces),
            });
        }

        Ok(out)
    }

    /// whisper-rs/ggml surface one flat error string for every encode/decode failure — there
    /// is no distinct OOM variant to match on. This is a heuristic: a Vulkan allocation
    /// failure's message reliably mentions one of these, and only ever happens on the gpu
    /// path, so a cpu-side failure never gets misread as OOM. Good enough per 07's spec
    /// ("if detecting OOM distinctly is genuinely impossible, implement heuristic detection").
    fn whisper_error(&self, msg: &str) -> Error {
        if self.device.is_gpu() && is_oom_message(msg) {
            Error::GpuOom
        } else {
            Error::Whisper(msg.to_string())
        }
    }
}

/// See `Transcriber::whisper_error`.
fn is_oom_message(msg: &str) -> bool {
    let m = msg.to_lowercase();
    ["out of device memory", "out of memory", "vk_error_out_of_device_memory", "oom", "allocation failed"]
        .iter()
        .any(|needle| m.contains(needle))
}

/// Whisper timestamps are centiseconds, everywhere, segments and tokens alike.
fn cs_to_ms(cs: i64) -> u64 {
    cs.max(0) as u64 * 10
}

/// Whisper emits sub-word tokens; a leading space marks the start of a real word. Phase 03
/// splits segments on speaker turns and needs word granularity, not bpe granularity.
fn merge_words(pieces: Vec<(String, u64, u64, f32)>) -> Vec<Word> {
    let mut words: Vec<Word> = Vec::new();
    let mut probs: Vec<Vec<f32>> = Vec::new();

    for (piece, start_ms, end_ms, p) in pieces {
        if piece.trim().is_empty() {
            continue;
        }
        let starts_word = piece.starts_with(' ') || words.is_empty();
        if starts_word {
            words.push(Word {
                text: piece.trim_start().to_string(),
                start_ms,
                end_ms,
                p,
            });
            probs.push(vec![p]);
        } else {
            let last = words.last_mut().expect("non-empty by construction");
            last.text.push_str(&piece);
            last.end_ms = last.end_ms.max(end_ms);
            probs.last_mut().expect("kept in step").push(p);
        }
    }

    for (word, ps) in words.iter_mut().zip(probs) {
        word.p = ps.iter().sum::<f32>() / ps.len() as f32;
        // token timestamps can invert on the odd token; a zero-length word beats a negative one
        word.end_ms = word.end_ms.max(word.start_ms);
    }
    words
}

/// whisper-rs collapses "file missing", "not a ggml file", and "truncated" into one
/// `InitError`, so anything that fails to load is reported as a missing model.
fn file_name(path: &Path) -> String {
    path.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_corrupt_model_is_reported_as_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ggml-bogus.bin");
        std::fs::write(&path, b"not a ggml file").unwrap();

        let err = match Transcriber::load(&path, Device::Cpu, Options::default()) {
            Err(e) => e,
            Ok(_) => panic!("loaded a garbage model"),
        };
        assert!(
            matches!(&err, Error::ModelMissing { name } if name == "ggml-bogus.bin"),
            "{err}"
        );
    }

    #[test]
    fn shifting_moves_words_with_the_segment() {
        let mut u = Utterance {
            start_ms: 100,
            end_ms: 900,
            text: "hi".into(),
            words: vec![Word {
                text: "hi".into(),
                start_ms: 100,
                end_ms: 900,
                p: 1.0,
            }],
        };
        u.shift(30_000);
        assert_eq!((u.start_ms, u.end_ms), (30_100, 30_900));
        assert_eq!((u.words[0].start_ms, u.words[0].end_ms), (30_100, 30_900));
    }

    fn pieces(raw: &[(&str, u64, u64, f32)]) -> Vec<(String, u64, u64, f32)> {
        raw.iter()
            .map(|&(t, a, b, p)| (t.to_string(), a, b, p))
            .collect()
    }

    #[test]
    fn explicit_device_never_probes() {
        assert_eq!(resolve(Device::Cpu), Resolved::Cpu);
        assert_eq!(resolve(Device::Gpu), Resolved::Gpu);
    }

    #[test]
    fn sub_word_tokens_glue_back_into_words() {
        let words = merge_words(pieces(&[
            (" quar", 0, 10, 0.9),
            ("ter", 10, 20, 0.8),
            ("ly", 20, 30, 0.7),
            (" review", 30, 60, 0.6),
        ]));

        assert_eq!(
            words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>(),
            ["quarterly", "review"]
        );
        assert_eq!((words[0].start_ms, words[0].end_ms), (0, 30));
        assert!((words[0].p - 0.8).abs() < 1e-5, "{}", words[0].p);
    }

    #[test]
    fn word_timestamps_never_run_backwards() {
        let words = merge_words(pieces(&[(" a", 50, 40, 1.0), ("b", 30, 20, 1.0)]));
        assert_eq!(words.len(), 1);
        assert!(words[0].end_ms >= words[0].start_ms);
    }

    #[test]
    fn blank_tokens_are_dropped() {
        assert!(merge_words(pieces(&[(" ", 0, 10, 1.0), ("", 10, 20, 1.0)])).is_empty());
    }

    #[test]
    fn centiseconds_become_milliseconds() {
        assert_eq!(cs_to_ms(300), 3_000);
        assert_eq!(cs_to_ms(-1), 0);
    }

    #[test]
    fn oom_messages_are_recognized_case_insensitively() {
        assert!(is_oom_message("vk_error_out_of_device_memory"));
        assert!(is_oom_message("ggml_vulkan: Device Memory allocation failed"));
        assert!(is_oom_message("CUDA out of memory"));
        assert!(!is_oom_message("failed to decode audio"));
    }

    #[test]
    fn oom_only_reported_on_the_gpu_path() {
        let device = Resolved::Cpu;
        let is_gpu_msg = device.is_gpu() && is_oom_message("out of memory");
        assert!(!is_gpu_msg, "a cpu run can't gpu-oom, whatever the message says");
    }
}
