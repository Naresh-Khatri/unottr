//! The whisper side of the model registry. Fetching and verification live in
//! [`crate::model`], which the diarization models share.

pub use crate::model::{ModelSpec, ModelStore, sha256_file};

const HF_WHISPER: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
const HF_VAD: &str = "https://huggingface.co/ggml-org/whisper-vad/resolve/main";

/// Transcription models, largest first. Hashes taken from the files this project was
/// developed against; a mismatch means upstream re-uploaded, not that the user is unlucky.
pub const MODELS: &[ModelSpec] = &[
    ModelSpec {
        name: "large-v3-turbo",
        file: "ggml-large-v3-turbo-q5_0.bin",
        base_url: HF_WHISPER,
        remote: "ggml-large-v3-turbo-q5_0.bin",
        size: 574_041_195,
        sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
    },
    ModelSpec {
        name: "medium",
        file: "ggml-medium-q5_0.bin",
        base_url: HF_WHISPER,
        remote: "ggml-medium-q5_0.bin",
        size: 539_212_467,
        sha256: "19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f",
    },
    ModelSpec {
        name: "small",
        file: "ggml-small-q5_1.bin",
        base_url: HF_WHISPER,
        remote: "ggml-small-q5_1.bin",
        size: 190_085_487,
        sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
    },
    ModelSpec {
        name: "base.en",
        file: "ggml-base.en.bin",
        base_url: HF_WHISPER,
        remote: "ggml-base.en.bin",
        size: 147_964_211,
        sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
    },
];

/// Silero v5 for whisper.cpp's standalone VAD. Small enough that we always fetch it.
pub const VAD: ModelSpec = ModelSpec {
    name: "silero-v5.1.2",
    file: "ggml-silero-v5.1.2.bin",
    base_url: HF_VAD,
    remote: "ggml-silero-v5.1.2.bin",
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
}
