#!/usr/bin/env bash
# eval-tier2-nightly-gate-selftest.sh — proves the Tier-2 nightly gate
# (issue #864) actually enforces its four red conditions (any red scenario,
# zero scenarios executed, budget breach, missing live-model secret) and
# passes only the all-green-within-budget case, PLUS structurally asserts the
# workflow file declares the schedule trigger, CI_CLASS, the enforced budget
# env, and carries no continue-on-error / secret-conditional `if:` guard on
# its harness or gate steps.
#
# A gate that never fails is worthless (mirrors
# tests/coverage-truth-selftest.sh's rationale), so every red-path assertion
# below drives scripts/eval-tier2-nightly-gate.sh against a REAL fixture and
# requires a NON-ZERO exit; the green path requires exit 0.
#
# USAGE
#   tests/eval-tier2-nightly-gate-selftest.sh
#   Exits 0 iff every assertion holds.

set -euo pipefail

if ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" && [ -n "$ROOT" ]; then
  :
else
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
cd "$ROOT"

GATE="scripts/eval-tier2-nightly-gate.sh"
AGGREGATE="scripts/eval-tier2-nightly-aggregate.py"
WORKFLOW=".github/workflows/eval-tier2-nightly.yml"

# Fixtures pinned by the dev-scout (issue #870) against the REAL, merged
# CorpusResult type (crates/sf-eval/tests/corpus_fixtures.rs round-trips
# these), so the green/red-scenario cases are schema-accurate, not guessed.
FIXTURE_GREEN="crates/sf-eval/tests/fixtures/corpus/result.green.json"
FIXTURE_MIXED="crates/sf-eval/tests/fixtures/corpus/result.mixed.json"
# Net-new fixtures for the two conditions the scenario-verdict-only envelope
# doesn't model on its own (issue #870's scout comment on #864): zero
# scenarios executed, and a budget-cap breach (stamped as the
# `"budget_exhausted"` failing_stage sentinel by
# scripts/eval-tier2-nightly-aggregate.py).
FIXTURE_ZERO="tests/fixtures/eval-tier2-nightly-gate/zero-scenarios.json"
FIXTURE_BUDGET="tests/fixtures/eval-tier2-nightly-gate/budget-breach.json"
FIXTURE_MALFORMED="tests/fixtures/eval-tier2-nightly-gate/malformed.json"

for f in "$GATE" "$AGGREGATE" "$WORKFLOW" "$FIXTURE_GREEN" "$FIXTURE_MIXED" \
         "$FIXTURE_ZERO" "$FIXTURE_BUDGET" "$FIXTURE_MALFORMED"; do
  if [ ! -f "$f" ]; then
    echo "SELFTEST FAIL  $f not found" >&2
    exit 1
  fi
done

fail=0

# ── Gate behavior: pass_case / reject_case, mirroring
# tests/coverage-truth-selftest.sh's pattern ──────────────────────────────────

pass_case() {
  local label="$1" fixture="$2" key="$3"
  local out
  if out="$(SF_LLM_API_KEY="$key" bash "$GATE" "$fixture" 2>&1)"; then
    echo "ok    [$label] gate exited 0 as expected"
  else
    echo "FAIL  [$label] expected exit 0 but gate FAILED: $out" >&2
    fail=1
  fi
}

reject_case() {
  local label="$1" fixture="$2" key="$3"
  local out rc=0
  out="$(SF_LLM_API_KEY="$key" bash "$GATE" "$fixture" 2>&1)" || rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "FAIL  [$label] expected NON-ZERO exit but gate PASSED" >&2
    fail=1
  elif [ -z "$out" ]; then
    echo "FAIL  [$label] gate exited non-zero but printed NO message (silent-skip violation)" >&2
    fail=1
  else
    echo "ok    [$label] gate rejected as expected (\"$out\")"
  fi
}

# AC1, in order: red-scenario, zero-scenarios, missing-secret, green;
# plus the fourth red condition (budget breach) and a defensive
# malformed-json case.
pass_case  "all-green-within-budget"  "$FIXTURE_GREEN"     "sk-ant-live-fake-key"
reject_case "red-scenario"            "$FIXTURE_MIXED"     "sk-ant-live-fake-key"
reject_case "zero-scenarios"          "$FIXTURE_ZERO"      "sk-ant-live-fake-key"
reject_case "budget-breach"           "$FIXTURE_BUDGET"    "sk-ant-live-fake-key"
reject_case "missing-secret"          "$FIXTURE_GREEN"     ""
reject_case "malformed-json"          "$FIXTURE_MALFORMED" "sk-ant-live-fake-key"

# ── Aggregate glue: RunResult -> CorpusResult, including the
# budget_exhausted stamp (issue #864) ────────────────────────────────────────

AGG_TMPDIR="$(mktemp -d)"
trap 'rm -rf "$AGG_TMPDIR"' EXIT

# Accepted run -> green, no failing_stage.
cat >"$AGG_TMPDIR/accepted.json" <<'JSON'
{
  "scenario": "todo-app",
  "workspace_id": "00000000-0000-4000-8000-000000000864",
  "accepted": true,
  "turns_to_acceptable": 3,
  "turns_used": 3,
  "turn_budget": 40,
  "page_revisions": 5,
  "rungs": {"project_graph": true, "compiling_candidate": true},
  "deterministic": {"seed": true, "ingest": true, "semantic_search": true},
  "elapsed_seconds": 120,
  "browser_smoke": "skipped"
}
JSON
"$AGGREGATE" "$AGG_TMPDIR/accepted.json" 40 5400 "$AGG_TMPDIR/accepted-out.json"
if [ "$(python3 -c "import json; d=json.load(open('$AGG_TMPDIR/accepted-out.json')); print(d['scenarios'][0]['green'], d['scenarios'][0]['failing_stage'])")" = "True None" ]; then
  echo "ok    [aggregate:accepted] green, no failing_stage"
else
  echo "FAIL  [aggregate:accepted] expected green/None" >&2
  fail=1
fi

# Not accepted, turns_used >= turn_budget -> budget_exhausted.
cat >"$AGG_TMPDIR/budget.json" <<'JSON'
{
  "scenario": "todo-app",
  "workspace_id": "00000000-0000-4000-8000-000000000864",
  "accepted": false,
  "turns_to_acceptable": null,
  "turns_used": 4,
  "turn_budget": 4,
  "page_revisions": 2,
  "rungs": {"project_graph": false, "compiling_candidate": false},
  "deterministic": {"seed": true, "ingest": true, "semantic_search": true},
  "elapsed_seconds": 200,
  "browser_smoke": "skipped"
}
JSON
"$AGGREGATE" "$AGG_TMPDIR/budget.json" 4 5400 "$AGG_TMPDIR/budget-out.json"
if grep -q '"budget_exhausted"' "$AGG_TMPDIR/budget-out.json" && grep -q '"green": false' "$AGG_TMPDIR/budget-out.json"; then
  echo "ok    [aggregate:budget] stamped budget_exhausted + red"
else
  echo "FAIL  [aggregate:budget] expected budget_exhausted + red" >&2
  cat "$AGG_TMPDIR/budget-out.json" >&2
  fail=1
fi

# Missing per-scenario result.json -> zero-scenarios envelope.
"$AGGREGATE" "$AGG_TMPDIR/does-not-exist.json" 40 5400 "$AGG_TMPDIR/missing-out.json" 2>/dev/null || true
if [ "$(python3 -c "import json; print(json.load(open('$AGG_TMPDIR/missing-out.json'))['scenarios'])")" = "[]" ]; then
  echo "ok    [aggregate:missing] empty scenarios envelope"
else
  echo "FAIL  [aggregate:missing] expected empty scenarios array" >&2
  fail=1
fi

# ── Structural workflow assertions (issue #864 AC2) ──────────────────────────

assert_grep() {
  local label="$1" pattern="$2"
  if grep -qE "$pattern" "$WORKFLOW"; then
    echo "ok    [workflow:$label] present"
  else
    echo "FAIL  [workflow:$label] pattern not found: $pattern" >&2
    fail=1
  fi
}

assert_grep "schedule-cron"  '^\s*-\s*cron:\s*"'
assert_grep "ci-class"       '^\s*CI_CLASS:\s*heavy'
assert_grep "turn-budget-env"    'TURN_BUDGET'
assert_grep "deadline-budget-env" 'SF_EVAL_DEADLINE_SECS'
assert_grep "gate-step"       'scripts/eval-tier2-nightly-gate\.sh'

if grep -qE '^\s*continue-on-error:' "$WORKFLOW"; then
  echo "FAIL  [workflow:no-continue-on-error] found a continue-on-error: directive in $WORKFLOW" >&2
  fail=1
else
  echo "ok    [workflow:no-continue-on-error] absent"
fi

# No `if:` guard anywhere in the workflow may condition on a secret (that
# would let a missing-secret run silently short-circuit instead of the gate
# catching it loudly).
if grep -E '^\s*if:' "$WORKFLOW" | grep -qi 'secrets\.'; then
  echo "FAIL  [workflow:no-secret-conditional-if] found a secret-conditional if: guard" >&2
  fail=1
else
  echo "ok    [workflow:no-secret-conditional-if] absent"
fi

if [ "$fail" -ne 0 ]; then
  echo "SELFTEST FAIL" >&2
  exit 1
fi

echo "SELFTEST OK — eval-tier2-nightly-gate.sh enforces all four red conditions; workflow structure asserted"
