#!/usr/bin/env bash
# eval-tier2-nightly-dispatch-smoke.sh — the scripted dispatch smoke check for
# the Tier-2 nightly eval workflow (issue #864, AC3).
#
# Asserts that a minimal-budget `workflow_dispatch` run of
# .github/workflows/eval-tier2-nightly.yml actually REACHED THE GATE STEP and
# UPLOADED BOTH retained artifacts:
#
#   eval-tier2-nightly-result-json-<run_id>      (the corpus result.json)
#   eval-tier2-nightly-scenario-logs-<run_id>    (per-scenario results + logs)
#
# WHY A SEPARATE SCRIPT (and why it has an offline mode)
# ------------------------------------------------------
# GitHub only exposes a `workflow_dispatch` trigger for a workflow file that
# already exists on the DEFAULT branch, so this check cannot be executed
# against a feature branch before merge (`gh workflow run
# eval-tier2-nightly.yml --ref <branch>` → "workflow ... not found on the
# default branch"). Rather than leave the assertion as prose in a checklist,
# the assertion LOGIC lives here and is exercised in CI offline, against
# recorded GitHub API payloads (`--artifacts-json` / `--jobs-json`), by
# tests/eval-tier2-nightly-gate-selftest.sh. Post-merge, the identical logic
# runs against the live API with no flags.
#
# The two modes share one `assert_run` implementation, so what CI proves and
# what an operator runs post-merge are the same code path.
#
# USAGE
#   # Live: dispatch a minimal-budget run, watch it, assert on it.
#   scripts/eval-tier2-nightly-dispatch-smoke.sh --ref main
#
#   # Live: assert against an already-completed run.
#   scripts/eval-tier2-nightly-dispatch-smoke.sh --run-id 123456789
#
#   # Offline: assert against recorded API payloads (used by the selftest).
#   scripts/eval-tier2-nightly-dispatch-smoke.sh \
#       --artifacts-json <artifacts.json> --jobs-json <jobs.json>
#
# EXIT
#   0  iff the gate step executed (conclusion present and not "skipped") AND
#      both artifact names are present, unexpired, at the configured retention.
#   1  otherwise, always with a non-empty stderr message naming the cause.
#
# NOTE ON RUN CONCLUSION
#   `gh run watch --exit-status`'s status is REPORTED, not swallowed, but a
#   red run is not by itself a smoke failure: until an operator provisions the
#   `SF_LLM_API_KEY` repo secret, the workflow is DESIGNED to conclude red via
#   the gate's missing-secret condition (issue #864). What this smoke check
#   pins is the property that survives that: the pipeline reached the gate and
#   retained its artifacts, i.e. it did not silently skip.

set -euo pipefail

WORKFLOW_FILE="eval-tier2-nightly.yml"
GATE_STEP_NAME="Gate on the Tier-2 nightly result"
RESULT_ARTIFACT_PREFIX="eval-tier2-nightly-result-json-"
LOGS_ARTIFACT_PREFIX="eval-tier2-nightly-scenario-logs-"
EXPECTED_RETENTION_DAYS=30

REF=""
RUN_ID=""
BUDGET="minimal"
ARTIFACTS_JSON=""
JOBS_JSON=""

fail() {
  echo "eval-tier2-nightly-dispatch-smoke: FAIL — $1" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="${2:-}"; shift 2 ;;
    --run-id) RUN_ID="${2:-}"; shift 2 ;;
    --budget) BUDGET="${2:-}"; shift 2 ;;
    --artifacts-json) ARTIFACTS_JSON="${2:-}"; shift 2 ;;
    --jobs-json) JOBS_JSON="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,50p' "$0"; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

# ── The shared assertion: given an artifacts payload and a jobs payload,
# decide whether the run reached the gate and retained both artifacts. ────────
assert_run() {
  local artifacts_json="$1" jobs_json="$2"
  local verdict

  [ -f "$artifacts_json" ] || fail "artifacts payload not found at $artifacts_json"
  [ -f "$jobs_json" ] || fail "jobs payload not found at $jobs_json"

  # python3 stdlib json — no jq dependency, mirroring
  # scripts/eval-tier2-nightly-gate.sh. Always exits 0 from the python side;
  # the shell decides pass/fail on the printed verdict so `set -e` never trips
  # mid-parse.
  verdict="$(python3 - "$artifacts_json" "$jobs_json" "$GATE_STEP_NAME" \
                      "$RESULT_ARTIFACT_PREFIX" "$LOGS_ARTIFACT_PREFIX" \
                      "$EXPECTED_RETENTION_DAYS" <<'PYEOF'
import datetime
import json
import sys

artifacts_path, jobs_path, gate_step, result_prefix, logs_prefix, retention = sys.argv[1:7]
retention = int(retention)

def retention_days(art):
    """Effective retention of an artifact, in days.

    The REST artifact object has no `retention_days` field (it carries
    `created_at` / `expires_at`), so derive the window from those. Accept an
    explicit `retention_days` when a payload does carry one.
    """
    explicit = art.get("retention_days")
    if isinstance(explicit, int):
        return explicit
    created, expires = art.get("created_at"), art.get("expires_at")
    if not created or not expires:
        return None
    try:
        fmt = lambda s: datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
        return round((fmt(expires) - fmt(created)).total_seconds() / 86400)
    except ValueError:
        return None

def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        print(f"UNREADABLE {path}: {e}")
        sys.exit(0)

jobs = load(jobs_path)
artifacts = load(artifacts_path)

# --- The gate step must have EXECUTED (not skipped, not absent). -------------
steps = [
    s
    for job in jobs.get("jobs", []) or []
    for s in (job.get("steps", []) or [])
    if s.get("name") == gate_step
]
if not steps:
    print(f"GATE_ABSENT no step named {gate_step!r} in any job")
    sys.exit(0)

conclusion = steps[0].get("conclusion")
if conclusion in (None, "", "skipped"):
    print(f"GATE_NOT_EXECUTED step {gate_step!r} conclusion={conclusion!r}")
    sys.exit(0)

# --- Both retained artifacts must be present, unexpired, at retention. ------
found = artifacts.get("artifacts", []) or []
problems = []
for label, prefix in (("result.json", result_prefix), ("scenario-logs", logs_prefix)):
    matches = [a for a in found if str(a.get("name", "")).startswith(prefix)]
    if not matches:
        problems.append(
            f"no {label} artifact matching {prefix!r} "
            f"(found: {[a.get('name') for a in found]})"
        )
        continue
    art = matches[0]
    if art.get("expired") is True:
        problems.append(f"{label} artifact {art.get('name')!r} is expired")
    actual = retention_days(art)
    # +/-1d tolerance: the window is derived from API timestamps, so rounding
    # at the day boundary must not make a correctly-configured run red.
    if actual is None or abs(actual - retention) > 1:
        problems.append(
            f"{label} artifact {art.get('name')!r} retention={actual!r}d, expected {retention}d"
        )

if problems:
    print("ARTIFACTS_BAD " + "; ".join(problems))
    sys.exit(0)

print(f"OK gate step concluded {conclusion!r}; both artifacts retained {retention}d")
PYEOF
)"

  case "$verdict" in
    UNREADABLE*) fail "payload ${verdict#UNREADABLE }" ;;
    GATE_ABSENT*) fail "run never reached the gate step: ${verdict#GATE_ABSENT }" ;;
    GATE_NOT_EXECUTED*) fail "gate step did not execute: ${verdict#GATE_NOT_EXECUTED }" ;;
    ARTIFACTS_BAD*) fail "retained-artifact assertion failed: ${verdict#ARTIFACTS_BAD }" ;;
    OK*) echo "eval-tier2-nightly-dispatch-smoke: PASS — ${verdict#OK }" ;;
    *) fail "assertion produced an unrecognized verdict: $verdict" ;;
  esac
}

# ── Offline mode: recorded payloads, no network. ─────────────────────────────
if [ -n "$ARTIFACTS_JSON" ] || [ -n "$JOBS_JSON" ]; then
  if [ -z "$ARTIFACTS_JSON" ] || [ -z "$JOBS_JSON" ]; then
    fail "--artifacts-json and --jobs-json must be given together"
  fi
  assert_run "$ARTIFACTS_JSON" "$JOBS_JSON"
  exit 0
fi

# ── Live mode: dispatch (or reuse a run), watch, then assert. ────────────────
command -v gh >/dev/null 2>&1 || fail "gh CLI not found (required for live mode)"

REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
[ -n "$REPO" ] || fail "could not resolve the repository via gh"

if [ -z "$RUN_ID" ]; then
  [ -n "$REF" ] || fail "--ref is required when --run-id is not given"
  echo "dispatching $WORKFLOW_FILE on ref '$REF' with budget=$BUDGET ..."
  # A workflow_dispatch trigger is only exposed for a workflow file that
  # exists on the default branch; this fails loudly otherwise.
  gh workflow run "$WORKFLOW_FILE" --repo "$REPO" --ref "$REF" -f "budget=$BUDGET" \
    || fail "gh workflow run failed (is $WORKFLOW_FILE present on the default branch?)"

  # Give GitHub a moment to register the queued run, then resolve its id.
  for _ in $(seq 1 30); do
    RUN_ID="$(gh run list --repo "$REPO" --workflow "$WORKFLOW_FILE" --branch "$REF" \
                --event workflow_dispatch --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null || true)"
    [ -n "$RUN_ID" ] && [ "$RUN_ID" != "null" ] && break
    sleep 5
  done
  if [ -z "$RUN_ID" ] || [ "$RUN_ID" = "null" ]; then
    fail "could not resolve the dispatched run id"
  fi
fi

echo "watching run $RUN_ID ..."
WATCH_RC=0
gh run watch "$RUN_ID" --repo "$REPO" --exit-status || WATCH_RC=$?
echo "gh run watch --exit-status exited $WATCH_RC (red is EXPECTED until SF_LLM_API_KEY is provisioned)"

TMPDIR_SMOKE="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_SMOKE"' EXIT

gh api "/repos/$REPO/actions/runs/$RUN_ID/artifacts" >"$TMPDIR_SMOKE/artifacts.json" \
  || fail "gh api artifacts lookup failed for run $RUN_ID"
gh api "/repos/$REPO/actions/runs/$RUN_ID/jobs" >"$TMPDIR_SMOKE/jobs.json" \
  || fail "gh api jobs lookup failed for run $RUN_ID"

assert_run "$TMPDIR_SMOKE/artifacts.json" "$TMPDIR_SMOKE/jobs.json"
