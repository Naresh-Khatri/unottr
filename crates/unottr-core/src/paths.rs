use std::path::{Path, PathBuf};

use directories::ProjectDirs;

use crate::error::{Error, IoResultExt, Result};

/// Where everything on disk lives. Resolve once at startup and pass it down; nothing in
/// the crate should call `directories` or read the env on its own.
#[derive(Debug, Clone)]
pub struct Paths {
    data: PathBuf,
    cache: PathBuf,
    state: PathBuf,
}

impl Paths {
    pub fn resolve() -> Result<Self> {
        let dirs = ProjectDirs::from("", "", "unottr");

        // UNOTTR_DATA_DIR relocates cache and state too, so one env var fully isolates a
        // test run from the real install.
        let data = env_dir("UNOTTR_DATA_DIR");
        let cache = env_dir("UNOTTR_CACHE_DIR")
            .or_else(|| data.as_ref().map(|d| d.join("cache")))
            .or_else(|| dirs.as_ref().map(|d| d.cache_dir().to_path_buf()))
            .ok_or(Error::NoBaseDir("cache"))?;
        let state = env_dir("UNOTTR_STATE_DIR")
            .or_else(|| data.as_ref().map(|d| d.join("state")))
            .or_else(|| {
                dirs.as_ref()
                    .and_then(|d| d.state_dir().map(Path::to_path_buf))
            })
            // macos and windows have no state dir; logs sit under data there
            .or_else(|| dirs.as_ref().map(|d| d.data_dir().to_path_buf()))
            .ok_or(Error::NoBaseDir("state"))?;
        let data = match data {
            Some(d) => d,
            None => dirs
                .as_ref()
                .map(|d| d.data_dir().to_path_buf())
                .ok_or(Error::NoBaseDir("data"))?,
        };

        Ok(Self { data, cache, state })
    }

    pub fn data_dir(&self) -> &Path {
        &self.data
    }

    pub fn cache_dir(&self) -> &Path {
        &self.cache
    }

    pub fn state_dir(&self) -> &Path {
        &self.state
    }

    pub fn db_file(&self) -> PathBuf {
        self.data.join("unottr.db")
    }

    pub fn models_dir(&self) -> PathBuf {
        self.data.join("models")
    }

    /// Extracted 16 kHz mono pcm, ~115 MB per hour of audio. Disposable.
    pub fn pcm_cache_dir(&self) -> PathBuf {
        self.cache.join("pcm")
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.state.join("logs")
    }

    pub fn ensure(&self) -> Result<()> {
        for dir in [
            self.data.clone(),
            self.models_dir(),
            self.pcm_cache_dir(),
            self.logs_dir(),
        ] {
            std::fs::create_dir_all(&dir).at(&dir)?;
        }
        Ok(())
    }
}

fn env_dir(key: &str) -> Option<PathBuf> {
    std::env::var_os(key)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

#[cfg(test)]
impl Paths {
    /// Bypasses `directories`/env lookups so tests can get a concrete `Paths` pointed at a
    /// temp dir without racing on process-global env vars across parallel tests.
    pub fn for_test(root: &Path) -> Self {
        Self {
            data: root.join("data"),
            cache: root.join("cache"),
            state: root.join("state"),
        }
    }
}
