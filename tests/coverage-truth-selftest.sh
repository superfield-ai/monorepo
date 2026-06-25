#!/usr/bin/env bash
# coverage-truth-selftest.sh — proves check-coverage-truth.sh actually catches
# divergence (issue #759). A validator that never fails is worthless, so this
# self-test drives scripts/check-coverage-truth.sh against TAMPERED COPIES of
# coverage-truth.toml and asserts a NON-ZERO exit for each tamper, plus a ZERO
# exit on the real, untampered manifest.
#
# It never edits the committed coverage-truth.toml in place — every tamper is a
# copy in a throwaway temp dir, removed on exit.
#
# USAGE
#   tests/coverage-truth-selftest.sh
#   Exits 0 iff: the real manifest passes AND every tamper is rejected.

set -euo pipefail

if ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" && [ -n "$ROOT" ]; then
  :
else
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
cd "$ROOT"

CHECK="scripts/check-coverage-truth.sh"
MANIFEST="coverage-truth.toml"

if [ ! -x "$CHECK" ] && [ ! -f "$CHECK" ]; then
  echo "SELFTEST FAIL  $CHECK not found" >&2
  exit 1
fi
if [ ! -f "$MANIFEST" ]; then
  echo "SELFTEST FAIL  $MANIFEST not found" >&2
  exit 1
fi

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

fail=0

# pass_case: the check MUST exit 0 against the given manifest.
pass_case() {
  local label="$1" file="$2"
  if bash "$CHECK" "$file" >/dev/null 2>&1; then
    echo "ok    [$label] check passed as expected"
  else
    echo "FAIL  [$label] expected exit 0 but check FAILED" >&2
    fail=1
  fi
}

# reject_case: the check MUST exit non-zero against the given tampered manifest.
reject_case() {
  local label="$1" file="$2"
  if bash "$CHECK" "$file" >/dev/null 2>&1; then
    echo "FAIL  [$label] expected NON-ZERO exit but check PASSED (tamper undetected)" >&2
    fail=1
  else
    echo "ok    [$label] tamper rejected as expected"
  fi
}

# ── Baseline: the real manifest must pass ─────────────────────────────────────
pass_case "real-manifest" "$MANIFEST"

# ── Tamper 1: remove a [[unit]] row (drop crates/sf-eval block) ───────────────
T1="$TMPDIR/removed-row.toml"
awk '
  /^\[\[unit\]\]/ { block=""; capture=1 }
  capture {
    block = block $0 "\n"
    if ($0 ~ /^path = "crates\/sf-eval"/) { drop=1 }
    if ($0 == "") {
      if (!drop) printf "%s", block
      capture=0; drop=0; block=""
      next
    }
    next
  }
  { print }
  END { if (capture && !drop) printf "%s", block }
' "$MANIFEST" > "$T1"
reject_case "removed-row" "$T1"

# ── Tamper 2: falsify nexum tests_executed_in_ci (0 -> 5; breaks the guard) ───
T2="$TMPDIR/falsified-nexum.toml"
# nexum is now tests_executed_in_ci > 0 (embedder-coverage.yml runs it for real,
# issue #760). The regression to guard against is dropping it back to the
# zero-executed gap. Falsify the count to 0 and assert the check rejects it
# (both the under-claim reality cross-check and the explicit nexum >0 guard).
awk '
  /^path = "crates\/nexum"/ { innexum=1 }
  innexum && /^tests_executed_in_ci = / { sub(/= [0-9]+/, "= 0"); innexum=0 }
  { print }
' "$MANIFEST" > "$T2"
reject_case "falsified-nexum-count" "$T2"

# ── Tamper 3: over-claim a crate as compiled-only-but-executed (sf-cli 0->3) ──
T3="$TMPDIR/overclaim-crate.toml"
awk '
  /^path = "crates\/sf-cli"/ { incli=1 }
  incli && /^tests_executed_in_ci = 0/ { sub(/= 0/, "= 3"); incli=0 }
  { print }
' "$MANIFEST" > "$T3"
reject_case "overclaim-crate-executed" "$T3"

# ── Tamper 4: lie about migrated_in_ci (crates/nexum true -> false) ───────────
T4="$TMPDIR/falsified-migrated.toml"
awk '
  /^path = "crates\/nexum"/ { innexum=1 }
  innexum && /^migrated_in_ci = true/ { sub(/= true/, "= false"); innexum=0 }
  { print }
' "$MANIFEST" > "$T4"
reject_case "falsified-migrated" "$T4"

# ── Sanity: confirm each tamper file actually differs from the original ───────
for f in "$T1" "$T2" "$T3" "$T4"; do
  if cmp -s "$f" "$MANIFEST"; then
    echo "FAIL  tamper file $f is identical to the original (awk no-op)" >&2
    fail=1
  fi
done

# ── #789: a `--workspace`-widened seam must NOT over-claim per-crate coverage ─
# check-coverage-truth.sh credits a crate as executed only when rust.yml names
# it with a literal `cargo nextest run -p <crate>`. If the rust-test-seam is
# ever widened to `cargo nextest run --workspace` (dropping the per-crate `-p`
# flags), the parser loses its per-crate evidence and MUST reject the five `>0`
# rows as over-claims rather than silently keeping them green. These cases feed
# the validator a SYNTHETIC rust.yml via RUST_YML_OVERRIDE (the real manifest is
# untouched) and assert the loud-fail. The five crates are the ones rust.yml's
# seam names today; nexum stays credited via embedder-coverage.yml (read from
# the real repo), so a failure here is attributable to the seam widening alone.
SEAM_CRATES="-p sf-db -p sf-serve -p sharp -p superfield -p sf-loop"

# Control: a synthetic rust.yml that keeps the per-crate `-p` invocation must
# still PASS — proving the override mechanism itself does not change the verdict
# and isolating the `--workspace` case below as the only changed variable.
SYNTH_PINNED="$TMPDIR/rust-pinned.yml"
{
  echo "jobs:"
  echo "  rust-test-seam:"
  echo "    steps:"
  echo "      - run: |"
  echo "          cargo nextest run $SEAM_CRATES --profile ci --run-ignored all --no-tests=fail -E \"\$FILTER\""
} > "$SYNTH_PINNED"
if RUST_YML_OVERRIDE="$SYNTH_PINNED" bash "$CHECK" "$MANIFEST" >/dev/null 2>&1; then
  echo "ok    [workspace-overclaim:control] per-crate -p seam still passes via override"
else
  echo "FAIL  [workspace-overclaim:control] per-crate -p seam should pass but FAILED" >&2
  fail=1
fi

# The guard: a `--workspace` seam (no per-crate `-p`) must be REJECTED, because
# the five `>0` rows now lack per-crate execution evidence (over-claim).
SYNTH_WORKSPACE="$TMPDIR/rust-workspace.yml"
{
  echo "jobs:"
  echo "  rust-test-seam:"
  echo "    steps:"
  echo "      - run: |"
  echo "          cargo nextest run --workspace --profile ci --run-ignored all --no-tests=fail -E \"\$FILTER\""
} > "$SYNTH_WORKSPACE"
if RUST_YML_OVERRIDE="$SYNTH_WORKSPACE" bash "$CHECK" "$MANIFEST" >/dev/null 2>&1; then
  echo "FAIL  [workspace-overclaim] --workspace seam over-claims the 5 crates but check PASSED (silent over-claim — the parser must be updated in lockstep)" >&2
  fail=1
else
  echo "ok    [workspace-overclaim] --workspace seam rejected — no per-crate -p evidence, the 5 >0 rows are flagged as over-claims"
fi

if [ "$fail" -ne 0 ]; then
  echo "SELFTEST FAIL  one or more expectations were not met" >&2
  exit 1
fi

echo "SELFTEST PASS  real manifest passes; all 4 tampers rejected; --workspace over-claim guard holds."
exit 0
