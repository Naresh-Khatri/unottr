#!/usr/bin/env bash
# Phase 08.0 acceptance: re-running the Rust reproduces the committed fixtures byte for
# byte, apart from the timing fields. Deleted in 08.7 with dump-fixtures.sh.
#
#   scripts/verify-fixtures.sh jfk corpus-01     # a subset, when you don't want 25 minutes
#   scripts/verify-fixtures.sh                   # everything
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
GOLD=${GOLD:-$ROOT/fixtures}
FRESH=$(mktemp -d "${TMPDIR:-/tmp}/unottr-verify.XXXXXX")
trap 'rm -rf "$FRESH"' EXIT

OUT=$FRESH "$ROOT/scripts/dump-fixtures.sh" "$@"

fail=0
for dir in "$FRESH"/*/; do
  name=$(basename "$dir")
  for f in probe.json chunks.json utterances.json turns.json merged.json; do
    if ! diff -q "$GOLD/$name/$f" "$dir/$f" > /dev/null; then
      echo "DIFF  $name/$f" >&2
      fail=1
    fi
  done
  # meta carries wall clock, which is never reproducible; everything else in it is a count
  if ! node -e '
      const fs = require("fs");
      const strip = (p) => { const m = JSON.parse(fs.readFileSync(p, "utf8")); delete m.timing; return JSON.stringify(m); };
      process.exit(strip(process.argv[1]) === strip(process.argv[2]) ? 0 : 1);
    ' "$GOLD/$name/meta.json" "$dir/meta.json"; then
    echo "DIFF  $name/meta.json (counts, not timing)" >&2
    fail=1
  fi
  [[ $fail -eq 0 ]] && echo "ok    $name"
done

exit $fail
