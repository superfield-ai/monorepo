#!/usr/bin/env bash
# assemble-rust-test-seam-filter.selftest.sh — proves the FILTER assembled
# from scripts/rust-test-seam-filter.txt is string-identical to the
# pre-extraction inline FILTER (issue #869 acceptance criterion).
#
# This is the required proof that extracting the curated rust-test-seam
# nextest FILTER into a one-selector-per-line include file changed NO test
# selection: the committed golden file (scripts/rust-test-seam-filter.golden)
# is a byte-for-byte copy of the FILTER string that used to be hardcoded
# inline in .github/workflows/rust.yml's `rust-test-seam` job, and this
# selftest diffs the assembled output against it on every PR.
#
# Wired into .github/workflows/rust.yml's required `rust-test` job so a
# regression (a line edited without updating the golden, or an assembly bug)
# fails loudly instead of silently narrowing/widening the DB-gated corpus.
#
# Exits 0 iff the assembled FILTER is identical to the golden file; non-zero
# (with a diff on stderr) otherwise.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ASSEMBLE="$SCRIPT_DIR/assemble-rust-test-seam-filter.sh"
GOLDEN="$SCRIPT_DIR/rust-test-seam-filter.golden"

[ -x "$ASSEMBLE" ] || { echo "selftest: assembler not executable: $ASSEMBLE" >&2; exit 1; }
[ -f "$GOLDEN" ] || { echo "selftest: golden file missing: $GOLDEN" >&2; exit 1; }

ASSEMBLED="$("$ASSEMBLE")"

if ! diff -u "$GOLDEN" <(printf '%s\n' "$ASSEMBLED") >/tmp/rust-test-seam-filter.diff 2>&1; then
  echo "FAIL: assembled FILTER diverges from the pre-extraction golden expression:" >&2
  cat /tmp/rust-test-seam-filter.diff >&2
  exit 1
fi

echo "OK: FILTER assembled from scripts/rust-test-seam-filter.txt is string-identical to the pre-extraction inline FILTER."
