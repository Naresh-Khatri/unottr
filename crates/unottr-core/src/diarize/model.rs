//! The two onnx models diarization runs on. Both are small enough to bundle in app
//! resources (decision #16 keeps the first-run download to the whisper model alone);
//! until phase 07 does that, they come down through the same store as everything else.

pub use crate::model::{ModelSpec, ModelStore};

const HF_SEGMENTATION: &str =
    "https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main";
const HF_EMBEDDING: &str =
    "https://huggingface.co/csukuangfj/speaker-embedding-models/resolve/main";

/// Speech/overlap segmentation. Upstream calls it `model.onnx`, which is no name for a
/// file sharing a directory with four whisper models.
pub const SEGMENTATION: ModelSpec = ModelSpec {
    name: "pyannote-segmentation-3.0",
    file: "sherpa-pyannote-segmentation-3.0.onnx",
    base_url: HF_SEGMENTATION,
    remote: "model.onnx",
    size: 5_992_913,
    sha256: "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079",
};

/// Speaker embedding models, default first. The default is trained on Chinese *and*
/// English; the corpus is not English-only, and an embedder that has only ever heard one
/// language is the wrong thing to bet speaker identity on.
pub const EMBEDDINGS: &[ModelSpec] = &[
    ModelSpec {
        name: "campplus-zh-en",
        file: "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
        base_url: HF_EMBEDDING,
        remote: "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
        size: 28_281_164,
        sha256: "aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2",
    },
    ModelSpec {
        name: "campplus-en",
        file: "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx",
        base_url: HF_EMBEDDING,
        remote: "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx",
        size: 29_596_978,
        sha256: "357a834f702b80161e5b981182c038e18553c1f2ca752ed6cec2052365d4129b",
    },
    ModelSpec {
        name: "wespeaker-campplus",
        file: "wespeaker_en_voxceleb_CAM++.onnx",
        base_url: HF_EMBEDDING,
        remote: "wespeaker_en_voxceleb_CAM++.onnx",
        size: 29_292_684,
        sha256: "c46fad10b5f81e1aa4a60c162714208577093655076c5450f8c469e522ec54ef",
    },
];

pub fn find_embedding(name: &str) -> Option<&'static ModelSpec> {
    EMBEDDINGS.iter().find(|m| m.name == name)
}

pub fn default_embedding() -> &'static ModelSpec {
    &EMBEDDINGS[0]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_embedding_is_reachable_by_name() {
        for spec in EMBEDDINGS {
            assert_eq!(find_embedding(spec.name), Some(spec));
        }
    }

    #[test]
    fn local_names_do_not_collide() {
        let mut files: Vec<_> = EMBEDDINGS.iter().map(|m| m.file).collect();
        files.push(SEGMENTATION.file);
        let count = files.len();
        files.sort_unstable();
        files.dedup();
        assert_eq!(files.len(), count);
    }
}
