#!/usr/bin/env bash
# check-coverage-delta.sh — per-package coverage-delta gate (issue #766).
#
# PURPOSE
#   Enforce invariant 2 ("exit 0 != tested") at PACKAGE granularity: if a PR
#   modifies a Rust package, at least one of that package's tests must actually
#   have EXECUTED in CI. A green compile that ran zero tests for a touched
#   package is the embedder-style "merged green, never executed" failure; this
#   gate makes that condition RED.
#
# WHAT IT DOES
#   1. Reads a newline-delimited list of changed paths (the PR diff).
#   2. Maps each `crates/<dir>/...` path to its owning Cargo package (the `name`
#      field of `crates/<dir>/Cargo.toml`; falls back to <dir> if unreadable).
#   3. Reads a per-package executed-test-count report (JSON object
#      {"<package>": <int>, ...}) produced by the nextest jobs in rust.yml
#      (issue #764/#783 emit it via `--message-format libtest-json`).
#   4. For every TOUCHED package, asserts the report shows an executed count > 0.
#      Exits non-zero (1) listing each touched package that ran zero tests;
#      exits 0 when every touched package ran >0 tests.
#
#   SATISFIABILITY (required-context contract): if the diff touches NO Rust
#   package (TS-only / workflow-only / docs PRs), the gate is a NO-OP PASS
#   (exit 0). A required branch-protection context must never deadlock an
#   unrelated PR under strict=true (blocker #753), so "no Rust packages touched"
#   is an explicit, loud, green outcome — not an error.
#
# USAGE
#   scripts/check-coverage-delta.sh \
#       --changed-files <path>   # newline-delimited changed paths
#       --counts <path>          # per-package executed-count report (JSON)
#       [--workspace-root <dir>] # repo root for crate-name resolution
#                                # (default: `git rev-parse --show-toplevel`)
#
#   A package present in --changed-files but ABSENT from (or 0 in) --counts is
#   a violation: absence means no executed-test event was recorded for it.
#
# SELF-TEST
#   scripts/check-coverage-delta.selftest.sh feeds synthetic inputs and asserts
#   the zero-run-blocks / >0-run-passes / no-rust-no-op behaviours. It runs in
#   CI (the `coverage-delta` job in rust.yml) so the gate proves itself.

set -euo pipefail

CHANGED=""
COUNTS=""
WORKSPACE_ROOT=""

die() {
  echo "check-coverage-delta: $*" >&2
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --changed-files)
      CHANGED="${2:-}"
      shift 2
      ;;
    --counts)
      COUNTS="${2:-}"
      shift 2
      ;;
    --workspace-root)
      WORKSPACE_ROOT="${2:-}"
      shift 2
      ;;
    -h | --help)
      sed -n '2,40p' "$0"
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[ -n "$CHANGED" ] || die "missing required --changed-files <path>"
[ -n "$COUNTS" ] || die "missing required --counts <path>"
[ -f "$CHANGED" ] || die "changed-files list not found: $CHANGED"
[ -f "$COUNTS" ] || die "counts report not found: $COUNTS"

if [ -z "$WORKSPACE_ROOT" ]; then
  if WORKSPACE_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" && [ -n "$WORKSPACE_ROOT" ]; then
    :
  else
    WORKSPACE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
  fi
fi

command -v python3 >/dev/null 2>&1 || die "python3 is required"

CHANGED="$CHANGED" COUNTS="$COUNTS" WORKSPACE_ROOT="$WORKSPACE_ROOT" python3 - <<'PY'
import json
import os
import re
import sys

changed_path = os.environ["CHANGED"]
counts_path = os.environ["COUNTS"]
root = os.environ["WORKSPACE_ROOT"]

# ── Parse the per-package executed-count report ───────────────────────────────
try:
    with open(counts_path) as fh:
        raw = json.load(fh)
except Exception as exc:  # noqa: BLE001
    sys.stderr.write(f"check-coverage-delta: counts report is not valid JSON: {exc}\n")
    sys.exit(2)
if not isinstance(raw, dict):
    sys.stderr.write("check-coverage-delta: counts report must be a JSON object {pkg: int}\n")
    sys.exit(2)
counts = {}
for pkg, n in raw.items():
    try:
        counts[pkg] = int(n)
    except (TypeError, ValueError):
        sys.stderr.write(f"check-coverage-delta: non-integer count for {pkg!r}: {n!r}\n")
        sys.exit(2)


def owning_package(rel_path):
    """Map a `crates/<dir>/...` path to its owning Cargo package name.

    Resolves the package via the `name` field of crates/<dir>/Cargo.toml; falls
    back to the directory name when the manifest is unreadable. Returns None for
    any path that is not under crates/ (TS, docs, workflows, root files) — those
    own no Rust package and do not arm the gate.
    """
    parts = rel_path.replace("\\", "/").split("/")
    if len(parts) < 2 or parts[0] != "crates":
        return None
    crate_dir = parts[1]
    if not crate_dir:
        return None
    manifest = os.path.join(root, "crates", crate_dir, "Cargo.toml")
    try:
        with open(manifest) as fh:
            for line in fh:
                m = re.match(r'\s*name\s*=\s*"([^"]+)"', line)
                if m:
                    return m.group(1)
    except OSError:
        pass
    return crate_dir


# ── Map the changed files to the set of touched packages ──────────────────────
touched = {}  # package -> first path that touched it (for reporting)
with open(changed_path) as fh:
    for line in fh:
        path = line.strip()
        if not path:
            continue
        pkg = owning_package(path)
        if pkg is not None and pkg not in touched:
            touched[pkg] = path

if not touched:
    print("check-coverage-delta: PASS — diff touches no Rust package; gate is a no-op.")
    sys.exit(0)

print("check-coverage-delta: touched Rust packages and their executed-test counts:")
violations = []
for pkg in sorted(touched):
    n = counts.get(pkg, 0)
    flag = "OK" if n > 0 else "ZERO"
    print(f"  {pkg}: executed={n} ({flag})  [first touched by {touched[pkg]}]")
    if n <= 0:
        violations.append(pkg)

if violations:
    sys.stderr.write(
        "check-coverage-delta: FAIL — these touched packages ran ZERO tests in CI "
        "(exit 0 != tested):\n"
    )
    for pkg in violations:
        sys.stderr.write(f"  - {pkg}\n")
    sys.stderr.write(
        "A package modified by this PR must have >0 of its tests EXECUTE. Add or "
        "wire a test that runs for the package above, or confirm its tests are "
        "being collected by the nextest jobs in rust.yml.\n"
    )
    sys.exit(1)

print("check-coverage-delta: PASS — every touched Rust package ran >0 tests.")
sys.exit(0)
PY
