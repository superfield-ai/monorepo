#!/usr/bin/env bash
# check-coverage-truth.sh — STUB (dev-scout, issue #769).
#
# PURPOSE
#   This is a compile-safe stub that pins the CI seam for the coverage-truth
#   check. It validates that coverage-truth.toml parses as valid TOML and then
#   exits 0. It intentionally does NOT yet enforce the executed-coverage
#   inventory against reality — that is the job of the feature, issue #759.
#
#   Keeping this a no-op-enforcement stub makes the feature purely additive:
#   #759 fills in the real validation (one row per crates/* and packages/*,
#   asserting compiled_in_ci / migrated_in_ci / tests_executed_in_ci against
#   what CI actually executes, plus the nexum embedder tests_executed_in_ci=0
#   regression guard) and a self-test in tests/coverage-truth-selftest.sh.
#
# CANONICAL DOCS
#   docs/prd.md, docs/adr-embedding-model.md
#   Schema definition: header comment of coverage-truth.toml (this repo root).
#
# CI WIRING SEAM (pinned by #769, wired by #759)
#   Run this as a workflow step on pull_request -> main. The natural host is a
#   lightweight job with no Postgres/weights dependency (e.g. alongside the
#   typecheck/lint/format jobs in .github/workflows/build.yml):
#       - run: scripts/check-coverage-truth.sh
#   #769 does NOT make it a required branch-protection context; #759 owns that
#   decision per its scope (the coverage-enforcement phase makes it required).
#
# KEY FINDING (for #759)
#   No workflow runs `cargo test` / `cargo nextest`. rust.yml only does
#   `cargo build --workspace --all-targets` (compiles tests, never runs them).
#   So every crates/* row starts at tests_executed_in_ci=0; the nexum
#   integration suite is additionally DATABASE_URL-gated and silently skips.
#
# USAGE
#   scripts/check-coverage-truth.sh
#   Exits 0 when coverage-truth.toml parses; exits non-zero only if the manifest
#   is missing or is not valid TOML.

set -euo pipefail

# Resolve repo root regardless of where the script is invoked from.
if ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" && [ -n "$ROOT" ]; then
  :
else
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
cd "$ROOT"

MANIFEST="coverage-truth.toml"

if [ ! -f "$MANIFEST" ]; then
  echo "FAIL  $MANIFEST not found at repo root" >&2
  exit 1
fi

# Validate the manifest parses as TOML. tomllib is stdlib on Python >=3.11
# (present in the CI runner image); tomli is the importable backport for older
# Pythons. Try both so the stub passes both locally and in CI.
if command -v python3 >/dev/null 2>&1; then
  python3 - "$MANIFEST" <<'PY'
import sys
try:
    import tomllib as toml_mod  # Python >= 3.11
except ModuleNotFoundError:
    try:
        import tomli as toml_mod  # backport for Python < 3.11
    except ModuleNotFoundError:
        sys.stderr.write(
            "WARN  no tomllib/tomli available; skipping parse validation\n"
        )
        sys.exit(0)
with open(sys.argv[1], "rb") as fh:
    toml_mod.load(fh)
PY
  echo "PASS  $MANIFEST parses as valid TOML"
else
  echo "WARN  python3 not found; skipping TOML parse validation" >&2
fi

# STUB: full inventory enforcement is deferred to issue #759. Exit 0.
echo "OK    check-coverage-truth.sh stub (#769): enforcement deferred to #759"
exit 0
