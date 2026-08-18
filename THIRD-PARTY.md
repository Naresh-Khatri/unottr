# Third-party notices

unottr itself is MIT-licensed. It bundles or downloads the following at build/run time.

## ffmpeg / ffprobe — LGPL v3

The AppImage (and the tarball fallback, if built with `scripts/fetch-ffmpeg.sh`) bundles
a static `ffmpeg`/`ffprobe` from [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds),
`linux64-lgpl` flavor. Verified via `ffmpeg -version`: the `configuration:` line carries
`--enable-version3` and contains **no** `--enable-gpl`, `--enable-libx264`, or
`--enable-libx265` — this is the LGPLv3 build, not GPL. A GPL-configured ffmpeg would force
GPL onto the whole application (decision #21), so this distinction is load-bearing, not
cosmetic. Full license text ships alongside the binaries as `ffmpeg-LICENSE.txt`
(`resources/` in the bundle).

Source: <https://github.com/BtbN/FFmpeg-Builds>. Upstream project: <https://ffmpeg.org>.

If a system `ffmpeg`/`ffprobe` is used instead (the tarball/AUR path, decision #21's
non-primary artifact), its license is whatever that system package carries — not unottr's
concern, since nothing is bundled in that case.

## whisper.cpp / whisper-rs — MIT

Speech-to-text (decision #8). [whisper.cpp](https://github.com/ggml-org/whisper.cpp) and
its Rust bindings [whisper-rs](https://github.com/tazz4843/whisper-rs) are both MIT.
Statically linked into the `unottr`/`unottr-cli` binaries; no separate notice file ships,
per MIT's terms (this file *is* the notice).

## sherpa-onnx / sherpa-rs — Apache License 2.0

Speaker diarization (segmentation + embedding + clustering primitives, decision #9).
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) and its Rust bindings
[sherpa-rs](https://github.com/thewh1teagle/sherpa-rs) are both Apache-2.0. The rejoin/
prune clustering on top (see DESIGN.md's *Diarization*) is unottr's own code, MIT like the
rest of this repo.

## Models (downloaded on first use, not bundled)

None of these are compiled into the binary or included in the AppImage — they are fetched
into the model cache on first run / on demand (decision #16), same as any other user data.

| Model | Purpose | Source | License |
|---|---|---|---|
| `ggml-large-v3-turbo-q5_0.bin`, `ggml-medium-q5_0.bin`, `ggml-small-q5_1.bin`, `ggml-base.en.bin` | ASR (whisper.cpp GGUF) | [ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp) on Hugging Face | MIT (OpenAI Whisper weights, quantized by the whisper.cpp project) |
| `ggml-silero-v5.1.2.bin` | VAD | [ggml-org/whisper-vad](https://huggingface.co/ggml-org/whisper-vad) | MIT ([Silero VAD](https://github.com/snakers4/silero-vad)) |
| `sherpa-pyannote-segmentation-3.0.onnx` | speech/overlap segmentation | [csukuangfj/sherpa-onnx-pyannote-segmentation-3-0](https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0) | MIT (ONNX export of [pyannote/segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0)) |
| `3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx`, `3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx`, `wespeaker_en_voxceleb_CAM++.onnx` | speaker embeddings | [csukuangfj/speaker-embedding-models](https://huggingface.co/csukuangfj/speaker-embedding-models) | Apache-2.0 ([3D-Speaker](https://github.com/modelscope/3D-Speaker) / [WeSpeaker](https://github.com/wenet-e2e/wespeaker) CAM++) |

pyannote's own segmentation-3.0 weights carry an additional gated-access research notice
on Hugging Face for the original (non-ONNX) upload; the ONNX export used here is what
sherpa-onnx re-hosts under MIT. Re-check the source pages above before redistributing the
model files themselves (unottr only redistributes pointers/hashes, never the weights).
