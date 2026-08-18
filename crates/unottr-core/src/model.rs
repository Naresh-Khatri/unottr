//! Fetching and verifying the onnx/ggml model files the pipeline runs on. Nothing here
//! knows what a model is for; the registries live next to the stage that uses them.

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tracing::{info, warn};

use crate::cancel::CancelToken;
use crate::error::{Error, IoResultExt, Result};

/// A downloadable model file. `size` and `sha256` are both checked: size catches a
/// truncated download cheaply, sha256 catches a corrupt one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelSpec {
    pub name: &'static str,
    /// Filename in the store. Kept distinctive on purpose — upstream names like
    /// `model.onnx` would collide the moment a second one shows up.
    pub file: &'static str,
    pub base_url: &'static str,
    /// Path under `base_url`, which is not always what we want to call it on disk.
    pub remote: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

impl ModelSpec {
    pub fn url(&self) -> String {
        format!("{}/{}", self.base_url, self.remote)
    }
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

    const SPEC: ModelSpec = ModelSpec {
        name: "fake",
        file: "fake.bin",
        base_url: "https://example.invalid",
        remote: "fake.bin",
        size: 1024,
        sha256: "00",
    };

    #[test]
    fn a_wrong_sized_file_is_not_present() {
        let dir = tempfile::tempdir().unwrap();
        let store = ModelStore::new(dir.path());
        std::fs::write(store.path(&SPEC), b"nowhere near big enough").unwrap();

        assert!(!store.is_present(&SPEC));
        assert!(matches!(
            store.locate(&SPEC),
            Err(Error::ModelMissing { .. })
        ));
    }

    #[test]
    fn the_remote_name_can_differ_from_the_local_one() {
        let spec = ModelSpec {
            file: "sherpa-pyannote-segmentation-3.0.onnx",
            remote: "model.onnx",
            ..SPEC
        };
        assert_eq!(spec.url(), "https://example.invalid/model.onnx");
        assert_eq!(
            ModelStore::new("/m").path(&spec),
            std::path::Path::new("/m/sherpa-pyannote-segmentation-3.0.onnx")
        );
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
