#!/usr/bin/env bash
# Stages the vendor-neutral Vulkan *loader* for the AppImage (DESIGN decision #9). Run this
# before `pnpm dist`.
#
# Why it is needed: @fugood/node-whisper-linux-x64-vulkan has a hard DT_NEEDED on
# libvulkan.so.1 and a RUNPATH pointing at its build machine's SDK. On a host with no loader
# installed the addon fails to load at all — it does not degrade to CPU. Shipping the loader
# turns that into the intended behaviour: the loader finds no ICD and whisper runs on CPU.
#
# The loader ONLY. Never bundle an ICD (the vendor driver) — that would pin users to whatever
# driver this machine happens to have. Loader is Apache-2.0; see THIRD-PARTY.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/resources/lib"

SRC=""
for candidate in /usr/lib/libvulkan.so.1 /usr/lib/x86_64-linux-gnu/libvulkan.so.1 /usr/lib64/libvulkan.so.1; do
  [ -e "$candidate" ] && { SRC="$candidate"; break; }
done
if [ -z "$SRC" ]; then
  echo "no libvulkan.so.1 on this machine — install the vulkan loader (vulkan-icd-loader," >&2
  echo "libvulkan1, vulkan-loader) and re-run" >&2
  exit 1
fi

mkdir -p "$DEST"
# -L: resolve the symlink, the AppImage needs the real object
cp -L "$SRC" "$DEST/libvulkan.so.1"
echo "staged $SRC -> $DEST/libvulkan.so.1"
