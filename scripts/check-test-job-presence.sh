#!/usr/bin/env bash
# check-test-job-presence.sh — subsystem-test-job-presence guardrail (issue #767).
#
# WHAT THIS GUARDRAIL ENFORCES (test-coverage policy invariant 4 at subsystem
# granularity — "required checks must cover the languages present")
#   1. Every EXECUTED subsystem (a coverage-truth.toml [[unit]] with
#      tests_executed_in_ci > 0) must name, in its `executed_by` field, a
#      workflow whose status context is one of main's REQUIRED branch-protection
#      contexts. A subsystem whose only test job lives in a NON-required workflow
#      (or names no job at all) ships with "no executing test job in required
#      checks" and makes this check exit non-zero (RED), never a silent green.
#   2. Every LANGUAGE present (Rust for crates/*, TypeScript for packages/*) must
#      have at least one such required executing test job. If a whole language
#      ships with zero required executing coverage, the check exits non-zero.
#
#   Subsystems recorded with tests_executed_in_ci = 0 are KNOWN, documented gaps
#   (e.g. crates/sf-cli, packages/control) tracked by coverage-truth.toml itself
#   and validated by check-coverage-truth.sh; they are not re-flagged here. This
#   guardrail layers the "is the executing job a REQUIRED context?" assertion on
#   top of the unit→executing-job mapping that check-coverage-truth.sh derives.
#
# ── COVERAGE-TRUTH UNIT→TEST-JOB MAPPING SOURCE (the seam this stub pins) ─────
#   The authoritative mapping from a subsystem/unit to "which CI job executes
#   its tests" already exists and MUST be the single source of truth the real
#   guardrail reads — do not re-derive it independently:
#
#   1. coverage-truth.toml (repo root) — the per-unit manifest. One [[unit]]
#      row per directory under crates/* and packages/*, each carrying
#      `tests_executed_in_ci` (int): 0 == no CI job runs this unit's tests,
#      >0 == at least one job does. This is the canonical inventory of which
#      units are EXECUTED vs merely compiled.
#
#   2. scripts/check-coverage-truth.sh (issue #759; wired as the `coverage-truth`
#      job in .github/workflows/build.yml) — the validator that derives the
#      unit→executing-job reality DIRECTLY from the workflows + filesystem and
#      asserts the manifest matches. Its reality-derivation is the exact
#      mapping logic the presence guardrail should reuse:
#        * a CRATE is executed iff a workflow RUNS its tests — parsed from
#          embedder-coverage.yml (`cargo test -p <crate>`, issue #760) OR
#          rust.yml's DB-gated nextest job (`cargo nextest run -p <crate>`,
#          issue #765) — the job `name:` "Rust workspace tests (nextest,
#          no-tests=fail)" / "Rust test seam" lines in .github/workflows/rust.yml.
#        * a PACKAGE is executed iff it has *.test.ts under tests/unit or
#          tests/integration (the test-unit / test-integration globs).
#
#   3. scripts/check-coverage-delta.sh (issue #766/#783; the `coverage-delta`
#      required job in rust.yml) — maps each touched `crates/<dir>/...` path to
#      its owning Cargo package via `crates/<dir>/Cargo.toml` `name`, then
#      consumes the nextest libtest-json NDJSON per-package executed-count map.
#      This crates/<dir>→Cargo-package resolution is the same identity the
#      presence guardrail needs to name "which job covers package X".
#
#   In short: coverage-truth.toml says WHICH units must be executed;
#   check-coverage-truth.sh derives WHICH job executes each unit; the presence
#   guardrail (#767) layers on top to assert that executing job is a REQUIRED
#   branch-protection context (not merely present in some non-required workflow).
#
# CANONICAL DOCS
#   docs/prd.md — product requirements.
#   docs/testing-invariants.md — the four-invariant reference (skeleton pinned
#     by this same scout; prose filled by issue #768).
#   _shared/test-coverage-policy.md — the four invariants this guardrail serves:
#     (1) loud-skip-never-silent-skip, (2) exit-0≠tested,
#     (3) runtime-behaviour-needs-executed-assertion,
#     (4) required-checks-cover-languages-present (THIS guardrail enforces #4 at
#     subsystem granularity).
#
# USAGE
#   scripts/check-test-job-presence.sh [MANIFEST] [REQUIRED_CONTEXTS_FILE]
#     MANIFEST                default: coverage-truth.toml
#     REQUIRED_CONTEXTS_FILE  default: scripts/required-status-contexts.txt
#       A newline-delimited list of REQUIRED status-context names (blank /
#       `#`-prefixed lines ignored). Passed as an argument — NOT hardcoded — so
#       the self-test can drive the guardrail against a synthetic context list
#       (e.g. one missing all Rust contexts) and assert the language audit fires.
#   Exit 0 iff every executed subsystem maps to a required executing job AND each
#   language present has a required executing job; non-zero (listing each
#   violation) otherwise.

set -euo pipefail

# Resolve repo root regardless of where the script is invoked from.
if ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" && [ -n "$ROOT" ]; then
  :
else
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
cd "$ROOT"

MANIFEST="${1:-coverage-truth.toml}"
REQUIRED_CONTEXTS_FILE="${2:-scripts/required-status-contexts.txt}"

if [ ! -f "$MANIFEST" ]; then
  echo "FAIL  manifest not found: $MANIFEST" >&2
  exit 1
fi
if [ ! -f "$REQUIRED_CONTEXTS_FILE" ]; then
  echo "FAIL  required-contexts file not found: $REQUIRED_CONTEXTS_FILE" >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "FAIL  python3 is required to run $0" >&2
  exit 1
fi

# All real logic happens in Python (TOML parse + mapping). A missing TOML parser
# must HARD-FAIL — never a silent pass (that would defeat the guardrail).
ROOT="$ROOT" MANIFEST="$MANIFEST" REQUIRED_CONTEXTS_FILE="$REQUIRED_CONTEXTS_FILE" \
python3 - <<'PY'
import os
import sys

MANIFEST = os.environ["MANIFEST"]
REQUIRED_CONTEXTS_FILE = os.environ["REQUIRED_CONTEXTS_FILE"]

try:
    import tomllib as toml_mod  # Python >= 3.11
except ModuleNotFoundError:
    try:
        import tomli as toml_mod  # backport for Python < 3.11
    except ModuleNotFoundError:
        sys.stderr.write(
            "FAIL  no TOML parser available (need stdlib tomllib on Python>=3.11 "
            "or the `tomli` backport). Cannot run the guardrail.\n"
        )
        sys.exit(2)

# ── workflow filename -> the status context(s) its executing job produces ─────
# GitHub uses the job `name:` as the check-run / status-context identity. These
# strings are the verbatim job names of the test-EXECUTING jobs the manifest's
# `executed_by` field can reference. Keep in lockstep with the workflows; an
# `executed_by` naming a workflow absent from this map is a LOUD failure (forces
# the map to be maintained rather than silently skipping an unknown job).
WORKFLOW_CONTEXTS = {
    "embedder-coverage.yml": ["nexum embedder coverage (pgvector + governed weights)"],
    "rust.yml": [
        "Rust workspace tests (nextest, no-tests=fail)",
        "Rust coverage-delta (touched package ran >0 tests)",
    ],
    "test-unit.yml": ["Unit tests"],
    "test-integration.yml": ["Integration (API) tests"],
    "test-e2e.yml": ["E2E deploy (k3d)"],
}

LANGUAGE = {"crates": "Rust", "packages": "TypeScript"}

# ── Load the required-context list (the audited set) ──────────────────────────
required = []
with open(REQUIRED_CONTEXTS_FILE, "r", encoding="utf-8") as fh:
    for line in fh:
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        required.append(s)
required_set = set(required)
if not required_set:
    sys.stderr.write(
        f"FAIL  required-contexts file {REQUIRED_CONTEXTS_FILE} is empty — "
        "cannot audit language coverage against an empty set.\n"
    )
    sys.exit(2)

# ── Parse the manifest ────────────────────────────────────────────────────────
try:
    with open(MANIFEST, "rb") as fh:
        data = toml_mod.load(fh)
except Exception as exc:  # noqa: BLE001
    sys.stderr.write(f"FAIL  {MANIFEST} is not valid TOML: {exc}\n")
    sys.exit(2)

units = data.get("unit")
if not isinstance(units, list) or not units:
    sys.stderr.write(f"FAIL  no [[unit]] rows found in {MANIFEST}\n")
    sys.exit(2)

errors = []
languages_present = set()
# language -> True once a unit of that language is executed by a required job.
language_has_required_job = {}

for idx, row in enumerate(units):
    if not isinstance(row, dict):
        errors.append(f"[[unit]] #{idx}: not a table")
        continue
    path = row.get("path")
    if not isinstance(path, str) or "/" not in path:
        errors.append(f"[[unit]] #{idx}: missing/invalid path")
        continue
    top = path.split("/", 1)[0]
    lang = LANGUAGE.get(top)
    if lang is None:
        errors.append(f"[[unit]] {path}: path must be under crates/ or packages/")
        continue
    languages_present.add(lang)
    language_has_required_job.setdefault(lang, False)

    teic = row.get("tests_executed_in_ci")
    if not isinstance(teic, int) or isinstance(teic, bool):
        errors.append(f"[[unit]] {path}: tests_executed_in_ci must be an integer")
        continue

    # Subsystems with no executed suite are documented gaps (validated by
    # check-coverage-truth.sh); this guardrail only audits EXECUTED units.
    if teic <= 0:
        continue

    executed_by = row.get("executed_by")
    if not isinstance(executed_by, str) or not executed_by.strip():
        errors.append(
            f"[[unit]] {path}: tests_executed_in_ci={teic}>0 but names NO "
            f"executing job (executed_by empty) — subsystem ships with no "
            f"executing test job."
        )
        continue

    workflows = [w.strip() for w in executed_by.split(",") if w.strip()]
    unit_contexts = []
    unknown = []
    for wf in workflows:
        ctxs = WORKFLOW_CONTEXTS.get(wf)
        if ctxs is None:
            unknown.append(wf)
        else:
            unit_contexts.extend(ctxs)
    if unknown:
        errors.append(
            f"[[unit]] {path}: executed_by names unknown workflow(s) "
            f"{unknown} — add them to WORKFLOW_CONTEXTS so their required-context "
            f"identity is auditable (never silently skip an unknown job)."
        )
        # fall through: still evaluate any known contexts it also names.

    covered_by_required = sorted(set(unit_contexts) & required_set)
    if covered_by_required:
        language_has_required_job[lang] = True
    elif not unknown:
        errors.append(
            f"[[unit]] {path}: executed only by {workflows} -> context(s) "
            f"{sorted(set(unit_contexts))}, NONE of which is a REQUIRED status "
            f"context. Its executing test job is not a required branch-protection "
            f"context (false-green risk)."
        )

# ── Language audit (invariant 4): each language present needs a required job ───
for lang in sorted(languages_present):
    if not language_has_required_job.get(lang, False):
        errors.append(
            f"language {lang!r} is present in {MANIFEST} but NO required status "
            f"context executes any of its tests — invariant 4 violation "
            f"(required checks must cover the languages present)."
        )

if errors:
    sys.stderr.write(
        f"FAIL  {len(errors)} subsystem-test-job-presence violation(s):\n"
    )
    for e in errors:
        sys.stderr.write(f"  - {e}\n")
    sys.exit(1)

executed = sum(
    1
    for r in units
    if isinstance(r, dict) and isinstance(r.get("tests_executed_in_ci"), int)
    and not isinstance(r.get("tests_executed_in_ci"), bool)
    and r.get("tests_executed_in_ci") > 0
)
print(
    f"PASS  {MANIFEST}: {executed} executed subsystem(s) each map to a REQUIRED "
    f"executing test job; languages present "
    f"{sorted(languages_present)} each have a required executing job "
    f"(audited against {len(required_set)} required contexts)."
)
PY
