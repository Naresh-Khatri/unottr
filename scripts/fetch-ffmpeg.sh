#!/usr/bin/env bash
# Fetches the LGPL-licensed static ffmpeg/ffprobe build to bundle into the AppImage/tarball
# (decision #21). Not checked into git (224 MB) — run this before `pnpm tauri build`.
#
# LGPL, not GPL: this build is BtbN's "linux64-lgpl" flavor, configured with
# --enable-version3 and *without* --enable-gpl (no libx264/libx265 etc). A GPL-configured
# ffmpeg would force GPL onto the whole application. Verify with:
#   src-tauri/resources/ffmpeg -version
# and confirm the `configuration:` line has no --enable-gpl.
set -euo pipefail

URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-lgpl.tar.xz"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/src-tauri/resources"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$DEST"
echo "downloading $URL"
curl -sL --fail -o "$TMP/ffmpeg.tar.xz" "$URL"
tar xf "$TMP/ffmpeg.tar.xz" -C "$TMP"

SRC_DIR="$(find "$TMP" -maxdepth 1 -type d -name 'ffmpeg-*')"
cp "$SRC_DIR/bin/ffmpeg" "$SRC_DIR/bin/ffprobe" "$DEST/"
cp "$SRC_DIR/LICENSE.txt" "$DEST/ffmpeg-LICENSE.txt"
chmod +x "$DEST/ffmpeg" "$DEST/ffprobe"

echo "installed to $DEST"
"$DEST/ffmpeg" -version | head -2
