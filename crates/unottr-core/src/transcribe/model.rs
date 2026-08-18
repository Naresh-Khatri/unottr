use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tracing::{info, warn};

use crate::cancel::CancelToken;
use crate::error::{Error, IoResultExt, Result};

const HF_WHISPER: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
const HF_VAD: &str = "https://huggingface.co/ggml-org/whisper-vad/resolve/main";

/// A downloadable ggml model. `size` and `sha256` are both checked: size catches a
/// truncated download cheaply, sha256 catches a corrupt one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelSpec {
    pub name: &'static str,
    pub file: &'static str,
    pub base_url: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

impl ModelSpec {
    pub fn url(&self) -> String {
        format!("{}/{}", self.base_url, self.file)
    }
}

/// Transcription models, largest first. Hashes taken from the files this project was
/// developed against; a mismatch means upstream re-uploaded, not that the user is unlucky.
pub const MODELS: &[ModelSpec] = &[
    ModelSpec {
        name: "large-v3-turbo",
        file: "ggml-large-v3-turbo-q5_0.bin",
        base_url: HF_WHISPER,
        size: 574_041_195,
        sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
    },
    ModelSpec {
        name: "medium",
        file: "ggml-medium-q5_0.bin",
        base_url: HF_WHISPER,
        size: 539_212_467,
        sha256: "19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f",
    },
    ModelSpec {
        name: "small",
        file: "ggml-small-q5_1.bin",
        base_url: HF_WHISPER,
        size: 190_085_487,
        sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
    },
    ModelSpec {
        name: "base.en",
        file: "ggml-base.en.bin",
        base_url: HF_WHISPER,
        size: 147_964_211,
        sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
    },
];

/// Silero v5 for whisper.cpp's standalone VAD. Small enough that we always fetch it.
pub const VAD: ModelSpec = ModelSpec {
    name: "silero-v5.1.2",
    file: "ggml-silero-v5.1.2.bin",
    base_url: HF_VAD,
    size: 885_098,
    sha256: "29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf",
};

pub fn find(name: &str) -> Option<&'static ModelSpec> {
    MODELS.iter().find(|m| m.name == name)
}

/// `large-v3-turbo` measures 0.8x realtime on 12 cpu threads — slower than the meeting
/// itself — so the cpu path drops two sizes. See the phase 02 spike verdict.
pub fn default_for(gpu: bool) -> &'static ModelSpec {
    let name = if gpu { "large-v3-turbo" } else { "small" };
    find(name).expect("registry always carries the defaults")
}

/// The models directory, and everything that reads or writes it.
#[derive(Debug, Clone)]
pub struct ModelStore {
    dir: PathBuf,
}

impl ModelStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub fn path(&self, spec: &ModelSpec) -> PathBuf {
        self.dir.join(spec.file)
    }

    /// Cheap presence check — size only. `ensure` is what verifies the hash.
    pub fn is_present(&self, spec: &ModelSpec) -> bool {
        std::fs::metadata(self.path(spec)).is_ok_and(|m| m.len() == spec.size)
    }

    /// Path to an already-downloaded model, or `ModelMissing` so the UI can offer to fetch
    /// it. Never downloads — callers that may block go through `ensure`.
    pub fn locate(&self, spec: &ModelSpec) -> Result<PathBuf> {
        if self.is_present(spec) {
            return Ok(self.path(spec));
        }
        Err(Error::ModelMissing {
            name: spec.name.to_string(),
        })
    }

    /// Download if absent, verify, and return the path. Resumes a partial `.part` file via
    /// an HTTP range request. `progress` gets 0.0..=1.0.
    pub fn ensure(
        &self,
        spec: &ModelSpec,
        progress: &dyn Fn(f32),
        cancel: &CancelToken,
    ) -> Result<PathBuf> {
        let final_path = self.path(spec);
        if self.is_present(spec) {
            return Ok(final_path);
        }
        cancel.check()?;

        std::fs::create_dir_all(&self.dir).at(&self.dir)?;
        let part = final_path.with_extension("part");
        download(spec, &part, progress, cancel)?;

        let digest = sha256_file(&part)?;
        if digest != spec.sha256 {
            // a wrong file that stays on disk gets "resumed" forever; kill it now
            let _ = std::fs::remove_file(&part);
            warn!(model = spec.name, expected = spec.sha256, got = %digest, "checksum mismatch");
            return Err(Error::Download {
                name: spec.name.to_string(),
                reason: format!("checksum mismatch (got {digest})"),
            });
        }

        std::fs::rename(&part, &final_path).at(&final_path)?;
        info!(model = spec.name, path = %final_path.display(), "model ready");
        Ok(final_path)
    }
}

fn download(
    spec: &ModelSpec,
    part: &Path,
    progress: &dyn Fn(f32),
    cancel: &CancelToken,
) -> Result<()> {
    let mut have = std::fs::metadata(part).map_or(0, |m| m.len());
    if have > spec.size {
        // longer than expected = not our file; start over
        have = 0;
    }

    let mut req = ureq::get(spec.url());
    if have > 0 {
        req = req.header("Range", format!("bytes={have}-"));
    }
    let mut resp = req.call().map_err(|e| fail(spec, e))?;

    let status = resp.status().as_u16();
    // 200 to a range request = server ignored it, so the bytes start at zero again
    let resuming = status == 206;
    if !(status == 200 || resuming) {
        return Err(Error::Download {
            name: spec.name.to_string(),
            reason: format!("http {status}"),
        });
    }
    if !resuming {
        have = 0;
    }

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false) // resuming: keep the bytes we already have
        .write(true)
        .open(part)
        .at(part)?;
    file.seek(SeekFrom::Start(have)).at(part)?;
    file.set_len(have).at(part)?;

    let mut reader = resp.body_mut().as_reader();
    let mut buf = vec![0u8; 256 * 1024];
    let mut written = have;
    progress(fraction(written, spec.size));

    loop {
        if cancel.is_cancelled() {
            // partial file is kept on purpose; the next run resumes it
            file.flush().at(part)?;
            return Err(Error::Cancelled);
        }
        let n = reader.read(&mut buf).map_err(|e| Error::Download {
            name: spec.name.to_string(),
            reason: e.to_string(),
        })?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).at(part)?;
        written += n as u64;
        progress(fraction(written, spec.size));
    }
    file.flush().at(part)?;

    if written != spec.size {
        return Err(Error::Download {
            name: spec.name.to_string(),
            reason: format!("expected {} bytes, got {written}", spec.size),
        });
    }
    Ok(())
}

fn fail(spec: &ModelSpec, e: ureq::Error) -> Error {
    Error::Download {
        name: spec.name.to_string(),
        reason: e.to_string(),
    }
}

fn fraction(done: u64, total: u64) -> f32 {
    if total == 0 {
        return 1.0;
    }
    (done as f32 / total as f32).clamp(0.0, 1.0)
}

pub fn sha256_file(path: &Path) -> Result<String> {
    let mut file = std::fs::File::open(path).at(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut buf).at(path)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_registry_entry_is_reachable_by_name() {
        for spec in MODELS {
            assert_eq!(find(spec.name), Some(spec));
        }
    }

    #[test]
    fn the_cpu_default_is_not_turbo() {
        assert_eq!(default_for(true).name, "large-v3-turbo");
        assert_ne!(default_for(false).name, "large-v3-turbo");
    }

    #[test]
    fn a_wrong_sized_file_is_not_present() {
        let dir = tempfile::tempdir().unwrap();
        let store = ModelStore::new(dir.path());
        let spec = &MODELS[0];
        std::fs::write(store.path(spec), b"nowhere near big enough").unwrap();

        assert!(!store.is_present(spec));
        assert!(matches!(
            store.locate(spec),
            Err(Error::ModelMissing { .. })
        ));
    }

    #[test]
    fn hashes_a_known_string() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x");
        std::fs::write(&path, b"abc").unwrap();
        assert_eq!(
            sha256_file(&path).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
