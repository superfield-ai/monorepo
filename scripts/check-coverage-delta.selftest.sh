#!/usr/bin/env bash
# check-coverage-delta.selftest.sh — self-test for the coverage-delta gate
# (issue #766 test plan).
#
# Feeds scripts/check-coverage-delta.sh synthetic inputs (a changed-file list +
# a synthetic per-package count report against a synthetic workspace root) and
# asserts the gate's contract:
#
#   1. ZERO-RUN BLOCKS  — touched package with count 0  -> non-zero exit.
#   2. MISSING BLOCKS   — touched package absent from report -> non-zero exit.
#   3. >0-RUN PASSES    — touched package with count > 0  -> exit 0.
#   4. NO-RUST NO-OP    — diff touches no Rust package    -> exit 0 (so the
#                         required context never deadlocks a TS-only PR).
#
# Exits 0 only if ALL cases behave as specified; non-zero (and loud) otherwise.
# Wired into CI via the `coverage-delta` job in rust.yml, so it executes for
# real on every PR (loud-skip-never-silent-skip): if python3 is missing or the
# gate regresses, the CI step fails.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GATE="$SCRIPT_DIR/check-coverage-delta.sh"

[ -x "$GATE" ] || { echo "selftest: gate not executable: $GATE" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ── Synthetic workspace: two crates, one with a dir != package-name to prove
#    the Cargo.toml `name` resolution (not just the directory basename). ────────
mkdir -p "$WORK/root/crates/widget/src" "$WORK/root/crates/gadget-dir/src" "$WORK/root/packages/web/src"
cat >"$WORK/root/crates/widget/Cargo.toml" <<'TOML'
[package]
name = "widget"
TOML
cat >"$WORK/root/crates/gadget-dir/Cargo.toml" <<'TOML'
[package]
name = "sf-gadget"
TOML
ROOT="$WORK/root"

fails=0
expect() {
  # expect <expected-exit> <case-name> -- <gate args...>
  local want="$1" name="$2"; shift 2
  [ "$1" = "--" ] && shift
  local got=0
  "$GATE" "$@" >/dev/null 2>&1 || got=$?
  if [ "$got" -eq "$want" ]; then
    echo "  PASS  $name (exit $got)"
  else
    echo "  FAIL  $name: expected exit $want, got $got" >&2
    fails=$((fails + 1))
  fi
}

# ── Case 1: ZERO-RUN BLOCKS ───────────────────────────────────────────────────
printf 'crates/widget/src/lib.rs\n' >"$WORK/changed1"
printf '{"widget": 0, "sf-gadget": 5}\n' >"$WORK/counts1"
expect 1 "zero-run for touched package blocks" -- \
  --changed-files "$WORK/changed1" --counts "$WORK/counts1" --workspace-root "$ROOT"

# ── Case 2: MISSING-FROM-REPORT BLOCKS ────────────────────────────────────────
printf 'crates/widget/src/lib.rs\n' >"$WORK/changed2"
printf '{"sf-gadget": 5}\n' >"$WORK/counts2"
expect 1 "touched package absent from report blocks" -- \
  --changed-files "$WORK/changed2" --counts "$WORK/counts2" --workspace-root "$ROOT"

# ── Case 3: >0-RUN PASSES (incl. dir != package-name resolution) ──────────────
printf 'crates/widget/src/lib.rs\ncrates/gadget-dir/src/lib.rs\n' >"$WORK/changed3"
printf '{"widget": 3, "sf-gadget": 1}\n' >"$WORK/counts3"
expect 0 ">0-run for every touched package passes" -- \
  --changed-files "$WORK/changed3" --counts "$WORK/counts3" --workspace-root "$ROOT"

# ── Case 4: NO-RUST NO-OP (TS / docs only) -> pass even with empty counts ─────
printf 'packages/web/src/app.ts\nREADME.md\n' >"$WORK/changed4"
printf '{}\n' >"$WORK/counts4"
expect 0 "no Rust package touched is a no-op pass" -- \
  --changed-files "$WORK/changed4" --counts "$WORK/counts4" --workspace-root "$ROOT"

# ── Case 5: mixed — one OK, one ZERO -> blocks (the zero dominates) ───────────
printf 'crates/widget/src/lib.rs\ncrates/gadget-dir/src/lib.rs\n' >"$WORK/changed5"
printf '{"widget": 4, "sf-gadget": 0}\n' >"$WORK/counts5"
expect 1 "any zero among touched packages blocks" -- \
  --changed-files "$WORK/changed5" --counts "$WORK/counts5" --workspace-root "$ROOT"

if [ "$fails" -ne 0 ]; then
  echo "check-coverage-delta.selftest: FAIL ($fails case(s) wrong)" >&2
  exit 1
fi
echo "check-coverage-delta.selftest: PASS (all cases)"
