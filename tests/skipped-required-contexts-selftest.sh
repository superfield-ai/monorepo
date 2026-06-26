#!/usr/bin/env bash
# skipped-required-contexts-selftest.sh — proves scripts/skipped-required-contexts.py
# decides the docs-only / workflow-only / code bypass correctly (issue #788).
#
# A bypass mechanism that is wrong in EITHER direction is dangerous:
#   * too eager  -> it posts success for a context whose real job IS running,
#                   masking a real failure (silent no-op — forbidden);
#   * too timid  -> a docs-only PR never gets its statuses and stays BLOCKED,
#                   reproducing blocker #753.
# So this self-test asserts the exact set of contexts the script reports for
# each diff shape, derived from the live required-status-contexts.txt and the
# real workflow path filters in this repo.
#
# It also proves the loud guards fire: an empty diff reports nothing, and
# `--validate` rejects a required context that maps to no workflow job.
#
# USAGE
#   tests/skipped-required-contexts-selftest.sh
#   Exits 0 iff every assertion holds.

set -euo pipefail

if ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" && [ -n "$ROOT" ]; then
  :
else
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
cd "$ROOT"

SCRIPT="scripts/skipped-required-contexts.py"
REQUIRED="scripts/required-status-contexts.txt"

for f in "$SCRIPT" "$REQUIRED"; do
  if [ ! -f "$f" ]; then
    echo "SELFTEST FAIL  $f not found" >&2
    exit 1
  fi
done

if ! command -v python3 >/dev/null 2>&1; then
  echo "SELFTEST FAIL  python3 is required" >&2
  exit 1
fi
if ! python3 -c 'import yaml' >/dev/null 2>&1; then
  echo "SELFTEST FAIL  PyYAML is required to run the self-test" >&2
  exit 1
fi

fail=0

# run <name> <changed-files-newline-blob>  -> echoes the sorted reported contexts
run() {
  CHANGED_FILES="$2" python3 "$SCRIPT" | LC_ALL=C sort
}

# assert_set <label> <actual> <expected>
assert_set() {
  local label="$1" actual="$2" expected="$3"
  if [ "$actual" = "$expected" ]; then
    echo "ok    $label"
  else
    echo "FAIL  $label" >&2
    echo "  expected:" >&2
    printf '%s\n' "$expected" | sed 's/^/    /' >&2
    echo "  actual:" >&2
    printf '%s\n' "$actual" | sed 's/^/    /' >&2
    fail=1
  fi
}

# The full required set (sorted) — every context must be reported on a pure-.md
# diff because every producing workflow path-ignores `**/*.md` / `**.md`.
ALL_SORTED="$(grep -vE '^\s*(#|$)' "$REQUIRED" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | LC_ALL=C sort)"

# 1) Pure docs (.md only, incl. nested + docs/**): ALL required contexts skip.
assert_set "pure .md diff -> all required contexts reported" \
  "$(run md $'README.md\ndocs/scout/x.md\npackages/db/README.md')" \
  "$ALL_SORTED"

# 2) Workflow-only diff: the build family ignores `.github/workflows/**` (so its
#    contexts are reported), but the Rust/embedder family ignores only md/txt and
#    therefore RUNS on a workflow change (so its contexts are NOT reported).
#    'Coverage truth' lives in build.yml (same path-ignore), so it is part of the
#    build family reported here (issue #790).
WF_EXPECTED="$(printf '%s\n' \
  'Compile and build container image' \
  'Coverage truth' \
  'Format' \
  'Integration (API) tests' \
  'Lint' \
  'Typecheck' \
  'Unit tests' | LC_ALL=C sort)"
assert_set "workflow-only diff -> build-family contexts reported, Rust/embedder NOT" \
  "$(run wf $'.github/workflows/foo.yml')" \
  "$WF_EXPECTED"

# 3) A real code file: every relevant workflow runs -> NOTHING reported.
assert_set "rust code file -> nothing reported (real jobs gate)" \
  "$(run code $'crates/nexum/src/embed.rs')" \
  ""

# 4) Mixed docs + code: the code file makes every workflow run -> NOTHING.
assert_set "mixed .md + code -> nothing reported" \
  "$(run mixed $'docs/a.md\ncrates/nexum/src/embed.rs')" \
  ""

# 5) Scripts-only (non-docs, non-workflow code): build ignores neither scripts/
#    nor changes them away, and Rust/embedder ignore only md/txt -> all run ->
#    NOTHING reported (the bypass must not fire for genuine source-of-truth code).
assert_set "scripts-only diff -> nothing reported" \
  "$(run scripts $'scripts/foo.py')" \
  ""

# 6) Empty diff (defensive): nothing to gate, nothing reported.
assert_set "empty diff -> nothing reported" \
  "$(run empty '')" \
  ""

# 7) --validate passes on the real repo (every required context maps to a job).
if python3 "$SCRIPT" --validate >/dev/null 2>&1; then
  echo "ok    --validate passes on the real required set"
else
  echo "FAIL  --validate should pass on the real required set" >&2
  fail=1
fi

# 8) --validate FAILS loudly when a required context maps to no workflow job.
#    Drive it against a tampered copy in a throwaway repo-shaped temp dir so the
#    committed file is never touched.
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT
mkdir -p "$TMPDIR/scripts" "$TMPDIR/.github/workflows"
cp -r .github/workflows/. "$TMPDIR/.github/workflows/"
cp "$SCRIPT" "$TMPDIR/scripts/skipped-required-contexts.py"
{
  grep -vE '^\s*(#|$)' "$REQUIRED"
  echo "Nonexistent context that maps to no job"
} > "$TMPDIR/scripts/required-status-contexts.txt"
if REPO_ROOT="$TMPDIR" python3 "$TMPDIR/scripts/skipped-required-contexts.py" --validate >/dev/null 2>&1; then
  echo "FAIL  --validate should reject a context with no producing workflow job" >&2
  fail=1
else
  echo "ok    --validate rejects an unmapped required context"
fi

if [ "$fail" -ne 0 ]; then
  echo "SELFTEST FAILED" >&2
  exit 1
fi
echo "SELFTEST PASSED"
