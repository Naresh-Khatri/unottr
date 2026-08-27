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

The Apple Silicon tester app builds FFmpeg from the upstream commit pinned in
`scripts/stage-ffmpeg-macos.sh`. It uses the same LGPL v3 boundary and rejects
`--enable-gpl` or `--enable-nonfree` before staging. The source revision, configure flags,
binary hashes, and LGPL v3 text ship beside the arm64 binaries.

If a system `ffmpeg`/`ffprobe` is used instead (a dev run, or an override set in Settings),
its license is whatever that system package carries — not unottr's concern, since nothing
is bundled in that case.

## Vulkan loader (`libvulkan.so.1`) — Apache License 2.0

The AppImage bundles the vendor-neutral
[Vulkan-Loader](https://github.com/KhronosGroup/Vulkan-Loader), staged by
`scripts/fetch-vulkan-loader.sh` from the build machine's own copy. **Only the loader** —
never an ICD (a vendor driver), which is what would drag in vendor licensing and pin users
to one GPU. See DESIGN.md's *Vulkan packaging* for why it has to ship at all.

## whisper.cpp — MIT

Speech-to-text (decision #8). [whisper.cpp](https://github.com/ggml-org/whisper.cpp) is
MIT, and so are the Node bindings
[`@fugood/whisper.node`](https://github.com/whisper-node/whisper.node) and its
`@fugood/node-whisper-linux-x64-vulkan` prebuild, which ships as a `.node` addon inside the
AppImage. The Apple Silicon tester app uses the project's Darwin arm64 Metal prebuild. No
separate notice file ships, per MIT's terms (this file *is* the notice).

## sherpa-onnx — Apache License 2.0

Speaker diarization (segmentation + embedding + clustering primitives, decision #9).
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) is Apache-2.0, as are its
`sherpa-onnx-node` bindings and the host-specific Linux x64 or Darwin arm64 prebuild bundled
in each app (which carries ONNX Runtime, also MIT). The rejoin/prune clustering on top (see
DESIGN.md's *Diarization*) is unottr's own code, MIT like the rest of this repo.

## Electron, Chromium and the npm dependency tree — MIT / BSD

The app ships on [Electron](https://github.com/electron/electron) (MIT), which embeds
Chromium (BSD-3-Clause and the licenses listed in its own `LICENSES.chromium.html`, shipped
inside the AppImage) and Node.js (MIT). Runtime npm dependencies — React, drizzle-orm,
better-sqlite3, chokidar, electron-log and the UI libraries — are MIT or ISC; `pnpm licenses
list --prod` prints the current set.

The Apple Silicon build also bundles
[`apple-silicon-metrics`](https://github.com/levibuzolic/apple-silicon-metrics) (MIT) for
sudo-less CPU and GPU temperature, usage, and power readings.

## Provider brand marks — trademarks of their owners

`src/renderer/src/ui/icons/providers/*.svg` are the OpenAI, Anthropic, Mistral, Ollama and
LM Studio marks, downloaded once from [theSVG](https://thesvg.org) (`npx @thesvg/cli add
<slug> --variant mono`) and committed rather than pulled in as a dependency. They are used
only to label the provider each connection points at. The marks remain the trademarks of
their respective owners and are not covered by this repo's MIT license; their presence is
nominative use, not endorsement or affiliation.

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
