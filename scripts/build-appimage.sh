#!/usr/bin/env bash
# `pnpm tauri build` assembles the AppDir correctly (cargo build, resource copy, linuxdeploy's
# library deployment) but in some sandboxed environments its final invocation of
# linuxdeploy-plugin-appimage fails with an opaque "failed to run linuxdeploy" while the exact
# same cached plugin binary runs fine invoked directly. If that happens, this packages the
# already-assembled AppDir by hand instead of giving up and falling back to the tarball.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPDIR="$ROOT/target/release/bundle/appimage/unottr.AppDir"
OUT="$ROOT/target/release/bundle/appimage/unottr_0.1.0_amd64.AppImage"
PLUGIN="$HOME/.cache/tauri/linuxdeploy-plugin-appimage.AppImage"

if pnpm tauri build; then
    echo "pnpm tauri build succeeded, nothing else to do"
    exit 0
fi

echo "tauri build's own AppImage step failed; trying the manual recovery path" >&2
[ -d "$APPDIR" ] || { echo "no AppDir at $APPDIR — tauri build didn't get far enough to recover" >&2; exit 1; }
[ -x "$PLUGIN" ] || { echo "no cached linuxdeploy-plugin-appimage at $PLUGIN — run tauri build once to fetch it" >&2; exit 1; }

cd "$ROOT/target/release/bundle/appimage"
APPIMAGE_EXTRACT_AND_RUN=1 ARCH=x86_64 "$PLUGIN" --appdir "$APPDIR"
mv unottr-x86_64.AppImage "$OUT"
echo "wrote $OUT"
