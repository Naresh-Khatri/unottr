#!/usr/bin/env bash
# pinned LGPL arm64 FFmpeg for the tester app
set -euo pipefail

FFMPEG_COMMIT="17c109e8d94d19976dc2f5db9c3577b3f831df43"
FFMPEG_REPOSITORY="https://git.ffmpeg.org/ffmpeg.git"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/resources/bin/darwin-arm64"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "stage-ffmpeg-macos.sh requires an Apple Silicon Mac" >&2
  exit 1
fi

for tool in clang file git install make shasum; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "missing required tool: $tool" >&2
    exit 1
  fi
done

git clone --quiet "$FFMPEG_REPOSITORY" "$TMP/ffmpeg"
git -C "$TMP/ffmpeg" checkout --quiet "$FFMPEG_COMMIT"
mkdir "$TMP/build"

CONFIGURE_FLAGS=(
  --prefix="$TMP/install"
  --arch=arm64
  --target-os=darwin
  --cc=clang
  --enable-version3
  --enable-static
  --disable-shared
  --disable-doc
  --disable-debug
  --disable-network
  --disable-autodetect
  --enable-pthreads
  --enable-ffmpeg
  --enable-ffprobe
)

export MACOSX_DEPLOYMENT_TARGET=13.0
export CFLAGS="-O2 -mmacosx-version-min=13.0"
export LDFLAGS="-mmacosx-version-min=13.0"

(
  cd "$TMP/build"
  "$TMP/ffmpeg/configure" "${CONFIGURE_FLAGS[@]}"
)
make -C "$TMP/build" -j "$(sysctl -n hw.logicalcpu)"
make -C "$TMP/build" install

BUILT_FFMPEG="$TMP/install/bin/ffmpeg"
BUILT_FFPROBE="$TMP/install/bin/ffprobe"
VERSION="$($BUILT_FFMPEG -version)"
if grep -Eq -- '--enable-(gpl|nonfree)' <<<"$VERSION"; then
  echo "refusing to stage a GPL or nonfree FFmpeg build" >&2
  exit 1
fi
ARM64_COUNT="$(file "$BUILT_FFMPEG" "$BUILT_FFPROBE" | grep -c 'Mach-O 64-bit executable arm64')"
if [[ "$ARM64_COUNT" != "2" ]]; then
  echo "staged FFmpeg binaries are not arm64 Mach-O executables" >&2
  exit 1
fi
"$BUILT_FFPROBE" -version >/dev/null

mkdir -p "$DEST"
install -m 0755 "$BUILT_FFMPEG" "$BUILT_FFPROBE" "$DEST/"
install -m 0644 "$TMP/ffmpeg/COPYING.LGPLv3" "$DEST/ffmpeg-LICENSE.txt"

{
  echo "repository=$FFMPEG_REPOSITORY"
  echo "commit=$FFMPEG_COMMIT"
  echo "deployment_target=$MACOSX_DEPLOYMENT_TARGET"
} > "$DEST/ffmpeg-source.txt"
printf '%s\n' "${CONFIGURE_FLAGS[@]}" > "$DEST/ffmpeg-configure.txt"

(
  cd "$DEST"
  shasum -a 256 ffmpeg ffprobe > ffmpeg-sha256.txt
)

echo "staged FFmpeg $FFMPEG_COMMIT in $DEST"
"$DEST/ffmpeg" -version | head -n 3
