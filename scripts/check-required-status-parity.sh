#!/usr/bin/env bash
# check-required-status-parity.sh — branch-protection <-> required-status-
# contexts.txt parity guardrail (issue #846).
#
# WHY THIS EXISTS
#   scripts/required-status-contexts.txt is documented as the canonical mirror
#   of main's live branch-protection `required_status_checks.contexts`
#   (consumed by scripts/check-test-job-presence.sh,
#   scripts/skipped-required-contexts.py, and .github/workflows/
#   required-status-bypass.yml). Nothing previously asserted that the LIVE
#   GitHub setting actually matches the file: a context could be added to the
#   file (and to the workflow that documents it as "required") without ever
#   being added to main's branch-protection rule, so a red run of that job
#   would silently NOT block a merge — exactly the drift issue #846 found for
#   "Sharp merge-guarantee (compile-gate refusal + scenarios)" (#837) and
#   "Manifest gate (lint-manifest)" (#824/#828).
#
# WHAT IT DOES
#   Diffs two context sets — required-status-contexts.txt (the file) and
#   main's live required_status_checks.contexts (branch-protection API) — and
#   fails loudly (non-zero, listing every divergence) unless they match
#   EXACTLY in both directions:
#     - a context present in the file but absent live -> that job's red runs
#       do not block merges (the drift issue #846 found).
#     - a context present live but absent from the file -> the file is stale
#       and downstream consumers (skipped-required-contexts.py,
#       check-test-job-presence.sh) would silently miss it.
#
# USAGE
#   scripts/check-required-status-parity.sh --self-test
#     No network. Builds two synthetic branch-protection fixtures in a temp
#     dir and re-invokes this script's --fixture mode against each, asserting:
#       1. a fixture MISSING a context present in required-status-contexts.txt
#          -> non-zero exit.
#       2. a fixture matching required-status-contexts.txt EXACTLY -> exit 0.
#     Exits 0 iff both cases behave as specified; non-zero (listing which case
#     misbehaved) otherwise.
#
#   scripts/check-required-status-parity.sh [--fixture FILE]
#       [--contexts-file FILE] [--repo OWNER/REPO] [--branch BRANCH]
#     Diffs CONTEXTS_FILE (default: scripts/required-status-contexts.txt)
#     against a branch-protection JSON document — from FILE if --fixture is
#     given, otherwise fetched LIVE from the GitHub API for BRANCH (default:
#     main) of REPO (default: $GITHUB_REPOSITORY, else the `origin` remote).
#     The JSON document may be either a full `GET .../branches/{branch}/
#     protection` response (this script reads `.required_status_checks.
#     contexts`) or a bare `{"contexts": [...]}` object.
#
#     Live fetch requires `curl` + `python3` and a token in $GH_TOKEN or
#     $GITHUB_TOKEN (falls back to `gh auth token` for local/interactive use).
#     Reading branch-protection requires admin/administration:read on the repo.
#
# Exit codes: 0 = parity (or, in --self-test, both cases behaved correctly);
#             1 = divergence found (or a self-test case misbehaved);
#             2 = usage / environment error (missing tool, missing token, ...).

set -euo pipefail

# Resolve repo root regardless of where the script is invoked from.
if ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" && [ -n "$ROOT" ]; then
  :
else
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
cd "$ROOT"

CONTEXTS_FILE="scripts/required-status-contexts.txt"
FIXTURE=""
REPO="${GITHUB_REPOSITORY:-}"
BRANCH="main"
SELF_TEST=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --self-test)
      SELF_TEST=1
      shift
      ;;
    --fixture)
      FIXTURE="${2:-}"
      shift 2
      ;;
    --contexts-file)
      CONTEXTS_FILE="${2:-}"
      shift 2
      ;;
    --repo)
      REPO="${2:-}"
      shift 2
      ;;
    --branch)
      BRANCH="${2:-}"
      shift 2
      ;;
    *)
      echo "check-required-status-parity: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if ! command -v python3 >/dev/null 2>&1; then
  echo "FAIL  python3 is required to run $0" >&2
  exit 2
fi

# ── The comparison core: CONTEXTS_FILE vs a branch-protection JSON document ────
# Shared by live mode, --fixture mode, and (indirectly, via re-invocation)
# --self-test. Never silently passes on a parse failure or an empty file.
compare() {
  local contexts_file="$1" json_file="$2"
  if [ ! -f "$contexts_file" ]; then
    echo "FAIL  contexts file not found: $contexts_file" >&2
    return 2
  fi
  if [ ! -f "$json_file" ]; then
    echo "FAIL  branch-protection JSON not found: $json_file" >&2
    return 2
  fi
  CONTEXTS_FILE="$contexts_file" JSON_FILE="$json_file" python3 - <<'PY'
import json
import os
import sys

contexts_path = os.environ["CONTEXTS_FILE"]
json_path = os.environ["JSON_FILE"]

required = []
with open(contexts_path, "r", encoding="utf-8") as fh:
    for line in fh:
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        required.append(s)
if not required:
    sys.stderr.write(f"FAIL  {contexts_path} lists no required contexts\n")
    sys.exit(2)
required_set = set(required)

try:
    with open(json_path, "r", encoding="utf-8") as fh:
        doc = json.load(fh)
except Exception as exc:  # noqa: BLE001
    sys.stderr.write(f"FAIL  {json_path} is not valid JSON: {exc}\n")
    sys.exit(2)

if isinstance(doc, dict) and "required_status_checks" in doc:
    rsc = doc.get("required_status_checks") or {}
    live = rsc.get("contexts")
elif isinstance(doc, dict) and "contexts" in doc:
    live = doc.get("contexts")
else:
    live = None

if not isinstance(live, list) or not all(isinstance(c, str) for c in live):
    sys.stderr.write(
        f"FAIL  {json_path} has no usable `.required_status_checks.contexts` "
        "or `.contexts` string array\n"
    )
    sys.exit(2)
live_set = set(live)

missing_live = sorted(required_set - live_set)
extra_live = sorted(live_set - required_set)

if missing_live or extra_live:
    sys.stderr.write("FAIL  required-status-contexts.txt <-> live branch-protection drift:\n")
    for c in missing_live:
        sys.stderr.write(
            f"  - MISSING LIVE: '{c}' is in {contexts_path} but NOT in live "
            "required_status_checks.contexts — a red run of this job would "
            "NOT block a merge.\n"
        )
    for c in extra_live:
        sys.stderr.write(
            f"  - MISSING FILE: '{c}' is live-required but absent from "
            f"{contexts_path} — the file is stale.\n"
        )
    sys.exit(1)

print(
    f"PASS  {contexts_path} matches live required_status_checks.contexts "
    f"exactly ({len(required_set)} context(s))."
)
PY
}

if [ "$SELF_TEST" -eq 1 ]; then
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT

  # Build the real required-context list once, from the real file, so the
  # synthetic fixtures are derived from ground truth rather than hand-copied
  # (and therefore cannot drift out of sync with the file this guardrail
  # actually ships against).
  mapfile -t REAL_CONTEXTS < <(
    grep -v '^[[:space:]]*#' "$CONTEXTS_FILE" | grep -v '^[[:space:]]*$'
  )
  if [ "${#REAL_CONTEXTS[@]}" -lt 2 ]; then
    echo "check-required-status-parity --self-test: need >=2 real contexts to build a MISSING fixture" >&2
    exit 2
  fi

  # Case 1: MISSING fixture — live is real contexts minus the last one.
  python3 - "$WORK/missing.json" "${REAL_CONTEXTS[@]:0:$((${#REAL_CONTEXTS[@]} - 1))}" <<'PY'
import json, sys
out, contexts = sys.argv[1], sys.argv[2:]
json.dump({"required_status_checks": {"contexts": contexts}}, open(out, "w"))
PY

  # Case 2: EXACT-MATCH fixture — live equals the real contexts verbatim.
  python3 - "$WORK/match.json" "${REAL_CONTEXTS[@]}" <<'PY'
import json, sys
out, contexts = sys.argv[1], sys.argv[2:]
json.dump({"required_status_checks": {"contexts": contexts}}, open(out, "w"))
PY

  fails=0

  got=0
  compare "$CONTEXTS_FILE" "$WORK/missing.json" >/dev/null 2>"$WORK/missing.err" || got=$?
  if [ "$got" -ne 0 ]; then
    echo "  PASS  fixture missing a required context -> non-zero exit ($got)"
  else
    echo "  FAIL  fixture missing a required context -> expected non-zero, got 0" >&2
    fails=$((fails + 1))
  fi

  got=0
  compare "$CONTEXTS_FILE" "$WORK/match.json" >"$WORK/match.out" 2>&1 || got=$?
  if [ "$got" -eq 0 ]; then
    echo "  PASS  fixture matching exactly -> exit 0"
  else
    echo "  FAIL  fixture matching exactly -> expected exit 0, got $got" >&2
    cat "$WORK/match.out" >&2
    fails=$((fails + 1))
  fi

  if [ "$fails" -ne 0 ]; then
    echo "check-required-status-parity --self-test: FAIL ($fails case(s) wrong)" >&2
    exit 1
  fi
  echo "check-required-status-parity --self-test: PASS (both cases)"
  exit 0
fi

if [ -n "$FIXTURE" ]; then
  compare "$CONTEXTS_FILE" "$FIXTURE"
  exit $?
fi

# ── Live mode: fetch main's real branch-protection document ───────────────────
if [ -z "$REPO" ]; then
  if REPO="$(git remote get-url origin 2>/dev/null | sed -E 's#^(git@|https://)([^:/]+)[:/](.+?)(\.git)?$#\3#')" && [ -n "$REPO" ]; then
    :
  else
    echo "FAIL  --repo not given and could not be derived from \$GITHUB_REPOSITORY or 'origin'" >&2
    exit 2
  fi
fi

TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
if [ -z "$TOKEN" ] && command -v gh >/dev/null 2>&1; then
  TOKEN="$(gh auth token 2>/dev/null || true)"
fi
if [ -z "$TOKEN" ]; then
  echo "FAIL  no GitHub token available (set \$GH_TOKEN, \$GITHUB_TOKEN, or 'gh auth login')" >&2
  exit 2
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "FAIL  curl is required to fetch live branch protection" >&2
  exit 2
fi

API_URL="${GITHUB_API_URL:-https://api.github.com}"
LIVE_JSON="$(mktemp)"
trap 'rm -f "$LIVE_JSON"' EXIT

http_code="$(
  curl -sS -o "$LIVE_JSON" -w "%{http_code}" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "${API_URL}/repos/${REPO}/branches/${BRANCH}/protection"
)"
if [ "$http_code" != "200" ]; then
  echo "FAIL  GET /repos/${REPO}/branches/${BRANCH}/protection returned HTTP ${http_code}:" >&2
  cat "$LIVE_JSON" >&2
  exit 2
fi

compare "$CONTEXTS_FILE" "$LIVE_JSON"
exit $?
