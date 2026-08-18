#!/usr/bin/env bash
# Fallback packaging path (07-hardening-and-packaging.md task 3): if the AppImage
# bundler's tooling download fails (linuxdeploy et al., fetched from GitHub on first use),
# this still produces something runnable — a tarball with the release binary and, if
# `fetch-ffmpeg.sh` has been run, a bundled LGPL ffmpeg/ffprobe next to it. `FfmpegCli`'s
# discovery already checks next to the running binary before falling back to `PATH`
# (crates/unottr-core/src/media/ffmpeg.rs), so no extra wiring is needed for this layout.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$ROOT/target/release/unottr"
OUT="$ROOT/target/package"
NAME="unottr-$(grep -m1 '"version"' "$ROOT/src-tauri/tauri.conf.json" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')-linux-x86_64"

[ -x "$BIN" ] || { echo "release binary not found at $BIN — run \`cargo build --release -p unottr\` first" >&2; exit 1; }

rm -rf "$OUT/$NAME"
mkdir -p "$OUT/$NAME"
cp "$BIN" "$OUT/$NAME/unottr"

# sherpa-onnx/onnxruntime ship as .so files next to the binary (.cargo/config.toml's
# $ORIGIN rpath finds them there); moving the binary without them breaks diarization.
for lib in libonnxruntime.so libsherpa-onnx-c-api.so libsherpa-onnx-cxx-api.so; do
    [ -f "$ROOT/target/release/$lib" ] && cp "$ROOT/target/release/$lib" "$OUT/$NAME/"
done

if [ -f "$ROOT/src-tauri/resources/ffmpeg" ]; then
    cp "$ROOT/src-tauri/resources/ffmpeg" "$ROOT/src-tauri/resources/ffprobe" "$OUT/$NAME/"
    cp "$ROOT/src-tauri/resources/ffmpeg-LICENSE.txt" "$OUT/$NAME/" 2>/dev/null || true
    echo "bundled ffmpeg/ffprobe alongside the binary"
else
    echo "no fetched ffmpeg found (run scripts/fetch-ffmpeg.sh first to bundle one) — this tarball expects a system ffmpeg on PATH"
fi

cp "$ROOT/README.md" "$ROOT/THIRD-PARTY.md" "$OUT/$NAME/" 2>/dev/null || true

tar -C "$OUT" -czf "$OUT/$NAME.tar.gz" "$NAME"
echo "wrote $OUT/$NAME.tar.gz"
