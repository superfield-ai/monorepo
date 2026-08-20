#!/usr/bin/env bash
# eval-tier2-nightly-gate.sh — the Tier-2 nightly eval gate (issue #864).
#
# Consumes a corpus-level result.json — the `CorpusResult` aggregate envelope
# pinned by the dev-scout (issue #870, `crates/sf-eval/src/corpus.rs`):
#
#   { "scenarios": [ { "scenario": "<name>", "green": <bool>,
#                      "failing_stage": "<string-or-null>" }, ... ] }
#
# — and decides red/green for the nightly workflow per docs/eval-design.md's
# plan of record. Per test-coverage invariant 1 (loud-skip, never silent-skip),
# every red path below prints a NON-EMPTY message to stderr before exiting 1;
# there is no silent-skip path.
#
# Four red conditions (docs/eval-design.md "Behaviour", issue #864 Scope):
#
#   1. missing secret     — the live pinned shipped default model's credential
#                            (SF_LLM_API_KEY) is unset/empty. Checked first and
#                            independent of result.json: an unset key would let
#                            the harness silently fall back to the deterministic
#                            fixture executor (docs/architecture.md) and still
#                            exit 0 — a fake green with nothing real exercised.
#   2. zero scenarios      — the envelope's `scenarios` array is empty (or the
#                            file itself is missing/unreadable), so nothing was
#                            actually executed.
#   3. budget breach       — any scenario's `failing_stage` is the
#                            `"budget_exhausted"` sentinel (stamped by the
#                            workflow's corpus-envelope step when a scenario's
#                            turn or wall-clock budget was hit without
#                            acceptance) — distinct from an ordinary red
#                            scenario so a breached budget is diagnosable from
#                            result.json alone.
#   4. any red scenario    — any scenario has `green: false` (any
#                            `failing_stage`, including `"budget_exhausted"`,
#                            which is also caught by condition 3 above).
#
# USAGE
#   scripts/eval-tier2-nightly-gate.sh <result.json>
#
# ENV
#   SF_LLM_API_KEY   must be non-empty — see condition 1 above.
#
# EXIT
#   0  iff the envelope names at least one scenario and every scenario is
#      green (no `budget_exhausted` failing_stage, no red scenario).
#   1  otherwise, always with a non-empty stderr message naming the cause.

set -euo pipefail

RESULT_JSON="${1:-}"

fail() {
  echo "eval-tier2-nightly-gate: RED — $1" >&2
  exit 1
}

[ -n "$RESULT_JSON" ] || fail "usage: eval-tier2-nightly-gate.sh <result.json>"

# ── Condition 1: missing-secret guard (checked before touching result.json) ──
if [ -z "${SF_LLM_API_KEY:-}" ]; then
  fail "SF_LLM_API_KEY is unset/empty — the live pinned shipped default model has no credential (would silently fall back to the fixture executor)"
fi

[ -f "$RESULT_JSON" ] || fail "result.json not found at $RESULT_JSON (zero scenarios executed)"

# ── Parse + evaluate the corpus envelope. python3 stdlib json — no jq
# dependency, mirroring the JSON-parsing pattern already used in
# .github/workflows/eval-todo-app.yml (the ci-runner image ships python3, not
# jq). Always exits 0 from the python side; the shell decides pass/fail on the
# printed verdict so `set -e` never trips mid-parse. ──────────────────────────
VERDICT="$(python3 - "$RESULT_JSON" <<'PYEOF'
import json
import sys

path = sys.argv[1]
try:
    with open(path) as f:
        data = json.load(f)
except (OSError, json.JSONDecodeError) as e:
    print(f"UNREADABLE {e}")
    sys.exit(0)

scenarios = data.get("scenarios")
if not isinstance(scenarios, list) or len(scenarios) == 0:
    print("ZERO_SCENARIOS")
    sys.exit(0)

budget_breached = [
    s.get("scenario", "?") for s in scenarios if s.get("failing_stage") == "budget_exhausted"
]
if budget_breached:
    print("BUDGET_BREACH " + ",".join(budget_breached))
    sys.exit(0)

red = [
    f"{s.get('scenario', '?')}({s.get('failing_stage') or 'unknown'})"
    for s in scenarios
    if not s.get("green")
]
if red:
    print("RED_SCENARIO " + ",".join(red))
    sys.exit(0)

print(f"GREEN {len(scenarios)}")
PYEOF
)"

case "$VERDICT" in
  UNREADABLE*)
    fail "result.json at $RESULT_JSON is unreadable/malformed: ${VERDICT#UNREADABLE }"
    ;;
  ZERO_SCENARIOS)
    fail "zero scenarios executed (empty scenarios array in $RESULT_JSON)"
    ;;
  BUDGET_BREACH*)
    fail "budget cap (turn + wall-clock) breached in scenario(s): ${VERDICT#BUDGET_BREACH }"
    ;;
  RED_SCENARIO*)
    fail "red scenario verdict(s): ${VERDICT#RED_SCENARIO }"
    ;;
  GREEN*)
    echo "eval-tier2-nightly-gate: GREEN — ${VERDICT#GREEN } scenario(s) all green"
    exit 0
    ;;
  *)
    fail "gate parser produced an unrecognized verdict: $VERDICT"
    ;;
esac
