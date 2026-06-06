#!/usr/bin/env bash
# update-hypothesis-status.sh — Phase-0 gate verification harness (dev-scout stub).
#
# Flips the YAML frontmatter `status` field in a hypothesis markdown file
# (docs/research/hypotheses/H*.md) from "untested" to "passed" or "failed",
# and records a backreference to the gate's results JSON file.
#
# Usage:
#   scripts/update-hypothesis-status.sh <hypothesis-file> <status> <results-path>
#
# Example:
#   scripts/update-hypothesis-status.sh \
#     docs/research/hypotheses/H1.1_postgres-sufficient-20m-blocks.md \
#     passed \
#     experiments/g1-postgres-scale/results/g1_20260507T120000Z.json
#
# Idempotency: re-running with the same arguments produces a byte-identical
# file. Re-running with a different status replaces the previous value.
#
# This is a SCOUT stub — no real gate experiments call it yet. Downstream
# issues #73 #74 #4 #3 will invoke it after writing their results JSON.
#
# Canonical references:
#   docs/research.md
#   docs/research/methodology.md
#   docs/research/queue.md

set -euo pipefail

usage() {
  echo "Usage: $0 <hypothesis-file> <passed|failed|untested> <results-path>" >&2
  exit 2
}

if [[ $# -ne 3 ]]; then
  usage
fi

HYPOTHESIS_FILE="$1"
NEW_STATUS="$2"
RESULTS_PATH="$3"

case "$NEW_STATUS" in
  passed|failed|untested) ;;
  *) echo "error: status must be one of passed|failed|untested" >&2; usage ;;
esac

if [[ ! -f "$HYPOTHESIS_FILE" ]]; then
  echo "error: hypothesis file not found: $HYPOTHESIS_FILE" >&2
  exit 1
fi

# ISO-8601 UTC timestamp; reproducible if SOURCE_DATE_EPOCH is set.
if [[ -n "${SOURCE_DATE_EPOCH:-}" ]]; then
  TS=$(date -u -d "@${SOURCE_DATE_EPOCH}" +"%Y-%m-%dT%H:%M:%SZ")
else
  TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
fi

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

# Validate that the file starts with a YAML frontmatter block.
if ! head -1 "$HYPOTHESIS_FILE" | grep -qx -- '---'; then
  echo "error: $HYPOTHESIS_FILE does not start with YAML frontmatter (---)" >&2
  exit 1
fi

# Locate the closing --- of the frontmatter (line number, 1-indexed).
END_LINE=$(awk 'NR>1 && /^---$/ {print NR; exit}' "$HYPOTHESIS_FILE")
if [[ -z "$END_LINE" ]]; then
  echo "error: unterminated YAML frontmatter in $HYPOTHESIS_FILE" >&2
  exit 1
fi

# Process the frontmatter portion: replace status; ensure last_tested and
# results_path are present (insert if missing, replace if present). Pass
# the body through unchanged. Idempotent.
awk -v end="$END_LINE" -v st="$NEW_STATUS" -v rp="$RESULTS_PATH" -v ts="$TS" '
  BEGIN { saw_results=0; saw_last_tested=0 }
  NR <= end {
    if ($0 ~ /^status:[[:space:]]/) {
      print "status: " st
      next
    }
    if ($0 ~ /^last_tested:[[:space:]]/) {
      print "last_tested: " ts
      saw_last_tested=1
      next
    }
    if ($0 ~ /^results_path:[[:space:]]/) {
      print "results_path: " rp
      saw_results=1
      next
    }
    if (NR == end) {
      if (!saw_last_tested) print "last_tested: " ts
      if (!saw_results)     print "results_path: " rp
      print $0
      next
    }
    print
    next
  }
  { print }
' "$HYPOTHESIS_FILE" > "$TMP"

# Only rewrite the file if content changed (preserves mtime when idempotent).
if ! cmp -s "$TMP" "$HYPOTHESIS_FILE"; then
  cp "$TMP" "$HYPOTHESIS_FILE"
fi

echo "updated: $HYPOTHESIS_FILE -> status=$NEW_STATUS results_path=$RESULTS_PATH"
