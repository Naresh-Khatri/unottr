#!/usr/bin/env bash
# Phase 08.0 oracle. Runs the Rust pipeline end to end over a fixed set of inputs and dumps
# the intermediates nothing persists, so the TypeScript port has something to be checked
# against. Deleted in 08.7 along with crates/.
#
#   scripts/dump-fixtures.sh            # every input
#   scripts/dump-fixtures.sh jfk        # just one
#
# Each run gets its own throwaway UNOTTR_DATA_DIR so the real database is untouched and
# recording/segment ids come out deterministic. Models are shared read-only via a symlink.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CLI=${UNOTTR_CLI:-$ROOT/target/release/unottr}
OUT=${OUT:-$ROOT/fixtures}
WORK=${WORK:-${TMPDIR:-/tmp}/unottr-fixtures}
MODELS=${MODELS:-$HOME/.local/share/unottr/models}

# pin the bundled pair; the copies on PATH are a different build
export UNOTTR_FFMPEG=${UNOTTR_FFMPEG:-$ROOT/target/release/ffmpeg}
export UNOTTR_FFPROBE=${UNOTTR_FFPROBE:-$ROOT/target/release/ffprobe}

# name | whisper model | source file
INPUTS=(
  "jfk|base.en|$HOME/.local/share/hyprwhspr/pywhispercpp-src/whisper.cpp/samples/jfk.wav"
  "corpus-01|large-v3-turbo|$HOME/2025-10-12 15-48-03.mp4"
  "corpus-02|large-v3-turbo|$HOME/2025-10-06 12-40-11.mp4"
  "corpus-03|large-v3-turbo|$HOME/Recordings/2026-08-18 11-32-12.mp4"
)

die() { echo "dump-fixtures: $*" >&2; exit 1; }
now_ms() { date +%s%3N; }

[[ -x $CLI ]] || die "no cli at $CLI (cargo build --release -p unottr-cli)"
[[ -d $MODELS ]] || die "no models at $MODELS"

run_one() {
  local name=$1 model=$2 src=$3
  [[ -f $src ]] || die "missing input: $src"

  local dir=$OUT/$name data=$WORK/$name
  mkdir -p "$dir"
  rm -rf "$data"
  mkdir -p "$data"
  ln -sfn "$MODELS" "$data/models"
  export UNOTTR_DATA_DIR=$data

  echo "== $name: $(basename "$src")"

  "$CLI" probe --select "$src" > "$dir/probe.json"

  local t0 t1 transcribe_ms diarize_ms
  t0=$(now_ms)
  "$CLI" transcribe "$src" --model "$model" --device gpu --dump-json "$dir" \
    > "$dir/transcribe.log" 2>&1
  t1=$(now_ms); transcribe_ms=$((t1 - t0))

  t0=$(now_ms)
  "$CLI" diarize "$src" --dump-json "$dir" > "$dir/diarize.log" 2>&1
  t1=$(now_ms); diarize_ms=$((t1 - t0))

  # everything the fixture depends on, so a mismatch later is attributable
  UNOTTR_META_NAME=$name \
  UNOTTR_META_SRC=$src \
  UNOTTR_META_MODEL=$model \
  UNOTTR_META_TRANSCRIBE_MS=$transcribe_ms \
  UNOTTR_META_DIARIZE_MS=$diarize_ms \
  UNOTTR_META_SHA=$(sha256sum "$src" | cut -d' ' -f1) \
  UNOTTR_META_BYTES=$(stat -c %s "$src") \
    node -e '
      const fs = require("fs"), path = require("path");
      const dir = process.argv[1];
      const e = process.env;
      const probe = JSON.parse(fs.readFileSync(path.join(dir, "probe.json"), "utf8"));
      const chunks = JSON.parse(fs.readFileSync(path.join(dir, "chunks.json"), "utf8"));
      const turns = JSON.parse(fs.readFileSync(path.join(dir, "turns.json"), "utf8"));
      const merged = JSON.parse(fs.readFileSync(path.join(dir, "merged.json"), "utf8"));
      const utt = JSON.parse(fs.readFileSync(path.join(dir, "utterances.json"), "utf8"));
      const speech = chunks.speech_ms / 1000;
      const audio = (probe.duration_ms ?? 0) / 1000;
      fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({
        name: e.UNOTTR_META_NAME,
        source: { path: e.UNOTTR_META_SRC, bytes: +e.UNOTTR_META_BYTES, sha256: e.UNOTTR_META_SHA },
        whisper_model: e.UNOTTR_META_MODEL,
        device: "gpu",
        audio_s: +audio.toFixed(3),
        speech_s: +speech.toFixed(3),
        chunks: chunks.chunks.length,
        vad_spans: chunks.spans.length,
        utterances: utt.reduce((n, c) => n + c.utterances.length, 0),
        speakers: turns.embeddings.length,
        turns: turns.turns.length,
        segments: merged.segments.length,
        split: merged.assigned.filter((a) => a.pieces.length > 1).length,
        unattributed: merged.assigned.reduce(
          (n, a) => n + a.pieces.filter((p) => p.speaker === null).length, 0),
        timing: {
          transcribe_s: +(e.UNOTTR_META_TRANSCRIBE_MS / 1000).toFixed(2),
          diarize_s: +(e.UNOTTR_META_DIARIZE_MS / 1000).toFixed(2),
          transcribe_rtf_over_speech: +(speech / (e.UNOTTR_META_TRANSCRIBE_MS / 1000)).toFixed(2),
          diarize_rtf_over_audio: +(audio / (e.UNOTTR_META_DIARIZE_MS / 1000)).toFixed(2),
        },
      }, null, 2) + "\n");
    ' "$dir"

  rm -rf "$data"
  echo "   -> $dir"
}

wanted=("$@")
for row in "${INPUTS[@]}"; do
  IFS='|' read -r name model src <<< "$row"
  if [[ ${#wanted[@]} -gt 0 ]]; then
    printf '%s\n' "${wanted[@]}" | grep -qx "$name" || continue
  fi
  run_one "$name" "$model" "$src"
done
