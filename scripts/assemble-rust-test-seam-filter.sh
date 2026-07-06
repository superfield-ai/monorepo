#!/usr/bin/env bash
# assemble-rust-test-seam-filter.sh — build the rust-test-seam nextest FILTER
# expression from the one-selector-per-line include file (issue #869).
#
# PURPOSE
#   .github/workflows/rust.yml's `rust-test-seam` job used to hardcode its
#   curated nextest FILTER as one long inline string that every phase issue
#   touching the DB-gated corpus (#860/#861/#862, later #865/#868) had to edit
#   in place — a shared-file hotspot. This script reads
#   scripts/rust-test-seam-filter.txt (one selector per line), wraps each
#   line in parens, and joins them with ` | ` so downstream issues instead
#   APPEND A LINE to the include file.
#
# USAGE
#   scripts/assemble-rust-test-seam-filter.sh [path/to/include-file]
#   Prints the assembled FILTER expression to stdout (defaults to
#   scripts/rust-test-seam-filter.txt). Exits non-zero if the include file is
#   missing or contains zero selector lines (loud-skip-never-silent-skip: an
#   empty assembled FILTER would silently collect zero nextest tests).
#
# CANONICAL DOCS
#   .github/workflows/rust.yml `rust-test-seam` job.
#   scripts/rust-test-seam-filter.txt (the include file itself).

set -euo pipefail

# Resolve repo root regardless of where the script is invoked from.
if ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" && [ -n "$ROOT" ]; then
  :
else
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi

INCLUDE_FILE="${1:-$ROOT/scripts/rust-test-seam-filter.txt}"

if [ ! -f "$INCLUDE_FILE" ]; then
  echo "assemble-rust-test-seam-filter: include file not found: $INCLUDE_FILE" >&2
  exit 1
fi

selectors=()
while IFS= read -r line; do
  # Skip blank lines and full-line comments (`#`-prefixed).
  case "$line" in
    ''|'#'*) continue ;;
  esac
  selectors+=("($line)")
done <"$INCLUDE_FILE"

if [ "${#selectors[@]}" -eq 0 ]; then
  echo "assemble-rust-test-seam-filter: zero selector lines in $INCLUDE_FILE — refusing to emit an empty FILTER" >&2
  exit 1
fi

# Join with " | " between elements.
joined=""
for i in "${!selectors[@]}"; do
  if [ "$i" -eq 0 ]; then
    joined="${selectors[$i]}"
  else
    joined="${joined} | ${selectors[$i]}"
  fi
done

printf '%s\n' "$joined"
