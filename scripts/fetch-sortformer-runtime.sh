#!/usr/bin/env bash
# Builds and stages QVAC's parakeet Sortformer CLI with the Vulkan ggml backend. The runtime
# is not checked into git; run this before packaging on Linux. Model weights are downloaded
# separately on first run and are never included in the app bundle.
set -euo pipefail

QVAC_COMMIT="a0f139bc26217b0d5d40dcb1b55c943e184898c1"
GGML_COMMIT="dfd445e54b78ca35c1a767a3b9d5d7411ebc805f"
SPIRV_COMMIT="0d25db97cb9b8f725e4c95e4553001710e7fc39d"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/resources/bin/sortformer"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git clone --quiet https://github.com/tetherto/qvac-ext-lib-whisper.cpp.git "$TMP/qvac-speech"
git -C "$TMP/qvac-speech" checkout --quiet "$QVAC_COMMIT"
git clone --quiet https://github.com/tetherto/qvac-ext-ggml.git \
  "$TMP/qvac-speech/engines/parakeet/ggml"
git -C "$TMP/qvac-speech/engines/parakeet/ggml" checkout --quiet "$GGML_COMMIT"
git clone --quiet https://github.com/KhronosGroup/SPIRV-Headers.git "$TMP/SPIRV-Headers"
git -C "$TMP/SPIRV-Headers" checkout --quiet "$SPIRV_COMMIT"

cmake -S "$TMP/qvac-speech/engines/parakeet" -B "$TMP/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_FLAGS="-I$TMP/SPIRV-Headers/include" \
  -DBUILD_SHARED_LIBS=ON \
  -DGGML_VULKAN=ON \
  -DPARAKEET_BUILD_EXECUTABLES=ON \
  -DPARAKEET_BUILD_EXAMPLES=OFF \
  -DPARAKEET_BUILD_TESTS=OFF
cmake --build "$TMP/build" --parallel "$(getconf _NPROCESSORS_ONLN)"

mkdir -p "$DEST"
cp -L "$TMP/build/parakeet" "$TMP/build/libqvac-parakeet.so.0" "$DEST/"
cp -L "$TMP/build/ggml/src/"libspeech-ggml*.so.0 "$DEST/"
cp "$TMP/qvac-speech/engines/parakeet/LICENSE" "$DEST/LICENSE-parakeet.txt"
cp "$TMP/qvac-speech/engines/parakeet/NOTICE" "$DEST/NOTICE.txt"
cp "$TMP/qvac-speech/engines/parakeet/ggml/LICENSE" "$DEST/LICENSE-ggml.txt"
chmod +x "$DEST/parakeet"

echo "staged Vulkan Sortformer runtime in $DEST"
LD_LIBRARY_PATH="$DEST${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" "$DEST/parakeet" --version
