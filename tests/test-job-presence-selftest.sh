#!/usr/bin/env bash
# test-job-presence-selftest.sh — proves check-test-job-presence.sh actually
# catches a subsystem that ships with no executing test job in the required
# checks (issue #767). A guardrail that never fails is worthless, so this
# self-test drives scripts/check-test-job-presence.sh against TAMPERED COPIES of
# coverage-truth.toml and SYNTHETIC required-context lists, asserting a NON-ZERO
# exit for each tamper plus a ZERO exit on the real manifest + canonical list.
#
# It never edits the committed coverage-truth.toml in place — every tamper is a
# copy in a throwaway temp dir, removed on exit.
#
# USAGE
#   tests/test-job-presence-selftest.sh
#   Exits 0 iff: the real manifest passes AND every tamper is rejected.

set -euo pipefail

if ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" && [ -n "$ROOT" ]; then
  :
else
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
cd "$ROOT"

CHECK="scripts/check-test-job-presence.sh"
MANIFEST="coverage-truth.toml"
REQUIRED="scripts/required-status-contexts.txt"

for f in "$CHECK" "$MANIFEST" "$REQUIRED"; do
  if [ ! -f "$f" ]; then
    echo "SELFTEST FAIL  $f not found" >&2
    exit 1
  fi
done

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

fail=0

# pass_case: the check MUST exit 0 against the given manifest + contexts list.
pass_case() {
  local label="$1" manifest="$2" contexts="$3"
  if bash "$CHECK" "$manifest" "$contexts" >/dev/null 2>&1; then
    echo "ok    [$label] check passed as expected"
  else
    echo "FAIL  [$label] expected exit 0 but check FAILED" >&2
    fail=1
  fi
}

# reject_case: the check MUST exit non-zero against the given inputs.
reject_case() {
  local label="$1" manifest="$2" contexts="$3"
  if bash "$CHECK" "$manifest" "$contexts" >/dev/null 2>&1; then
    echo "FAIL  [$label] expected NON-ZERO exit but check PASSED (tamper undetected)" >&2
    fail=1
  else
    echo "ok    [$label] tamper rejected as expected"
  fi
}

# ── Baseline: the real manifest + canonical required list must pass ───────────
pass_case "real-manifest" "$MANIFEST" "$REQUIRED"

# ── Tamper 1: an executed subsystem named with NO test job ────────────────────
# crates/nexum is executed (tests_executed_in_ci=11) by embedder-coverage.yml.
# Blank out its executed_by so it claims tests but names no executing job — the
# "subsystem ships with no executing test job" case the guardrail must reject.
T1="$TMPDIR/no-job.toml"
awk '
  /^path = "crates\/nexum"/ { innexum=1 }
  innexum && /^executed_by = / { sub(/= ".*"/, "= \"\""); innexum=0 }
  { print }
' "$MANIFEST" > "$T1"
reject_case "executed-unit-with-no-job" "$T1" "$REQUIRED"

# ── Tamper 2: an executed subsystem run only by a NON-required workflow ────────
# packages/cli is executed by test-unit.yml/test-integration.yml (required).
# Repoint it at test-e2e.yml only (context "E2E deploy (k3d)" is NOT required) —
# the subsystem then has a test job but not in the required checks.
T2="$TMPDIR/non-required-job.toml"
awk '
  /^path = "packages\/cli"/ { incli=1 }
  incli && /^executed_by = / { sub(/= ".*"/, "= \"test-e2e.yml\""); incli=0 }
  { print }
' "$MANIFEST" > "$T2"
reject_case "executed-unit-non-required-job" "$T2" "$REQUIRED"

# ── Tamper 3: an executed subsystem pointing at an unknown workflow ───────────
T3="$TMPDIR/unknown-job.toml"
awk '
  /^path = "crates\/sf-db"/ { indb=1 }
  indb && /^executed_by = / { sub(/= ".*"/, "= \"made-up-workflow.yml\""); indb=0 }
  { print }
' "$MANIFEST" > "$T3"
reject_case "executed-unit-unknown-workflow" "$T3" "$REQUIRED"

# ── Synthetic-context audits: Rust + TS must each appear in the given list ─────
# A list with ONLY the required executing contexts for both languages -> pass.
BOTH="$TMPDIR/contexts-both.txt"
{
  echo "nexum embedder coverage (pgvector + governed weights)"
  echo "Rust workspace tests (nextest, no-tests=fail)"
  echo "Unit tests"
  echo "Integration (API) tests"
} > "$BOTH"
pass_case "synthetic-both-languages" "$MANIFEST" "$BOTH"

# A list MISSING every Rust executing context -> Rust language audit must fire.
NO_RUST="$TMPDIR/contexts-no-rust.txt"
{
  echo "Unit tests"
  echo "Integration (API) tests"
} > "$NO_RUST"
reject_case "synthetic-missing-rust" "$MANIFEST" "$NO_RUST"

# A list MISSING every TS executing context -> TS language audit must fire.
NO_TS="$TMPDIR/contexts-no-ts.txt"
{
  echo "nexum embedder coverage (pgvector + governed weights)"
  echo "Rust workspace tests (nextest, no-tests=fail)"
} > "$NO_TS"
reject_case "synthetic-missing-ts" "$MANIFEST" "$NO_TS"

# ── Sanity: confirm each manifest tamper actually differs from the original ───
for f in "$T1" "$T2" "$T3"; do
  if cmp -s "$f" "$MANIFEST"; then
    echo "FAIL  tamper file $f is identical to the original (awk no-op)" >&2
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "SELFTEST FAIL  one or more expectations were not met" >&2
  exit 1
fi

echo "SELFTEST PASS  real manifest passes; all tampers + missing-language lists rejected."
exit 0
