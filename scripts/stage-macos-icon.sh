#!/usr/bin/env bash
# checked-in PNG -> electron-builder ICNS
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$ROOT/resources/icons/icon.png"
DEST="$ROOT/resources/icons/icon.icns"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "stage-macos-icon.sh requires macOS iconutil and sips" >&2
  exit 1
fi

ICONSET="$TMP/unottr.iconset"
mkdir "$ICONSET"
while read -r name pixels; do
  sips -z "$pixels" "$pixels" "$SOURCE" --out "$ICONSET/$name" >/dev/null
done <<'SIZES'
icon_16x16.png 16
icon_16x16@2x.png 32
icon_32x32.png 32
icon_32x32@2x.png 64
icon_128x128.png 128
icon_128x128@2x.png 256
icon_256x256.png 256
icon_256x256@2x.png 512
icon_512x512.png 512
icon_512x512@2x.png 1024
SIZES

iconutil -c icns "$ICONSET" -o "$DEST"
echo "staged $DEST"
