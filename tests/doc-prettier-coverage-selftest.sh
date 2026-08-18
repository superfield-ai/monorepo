#!/usr/bin/env bash
# doc-prettier-coverage-selftest.sh — anti-bypass + zero-files guard for markdown
# prettier coverage (issue #903).
#
# PURPOSE
#   `scripts/check-doc-prettier.sh` runs in the always-on Doc Conformance job.
#   This self-test proves that job is a real gate, not a silently-passing no-op:
#     * a deliberately unformatted markdown file inside the checked set makes the
#       same prettier invocation exit non-zero and names the file;
#     * a known-bad fixture yields a non-empty --list-different output, so a glob
#       that matches nothing can never masquerade as green;
#     * the regression fixtures from issues #885/#899 are inside the checked set
#       and are not hidden by `.prettierignore`.
#
# USAGE
#   tests/doc-prettier-coverage-selftest.sh
#   Exits 0 iff every guard passes.

set -euo pipefail

if ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" && [ -n "$ROOT" ]; then
  :
else
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
cd "$ROOT"

# Same prettier invocation as scripts/check-doc-prettier.sh. Arrays preserve the
# quoted globs so Prettier resolves them, not the shell.
PRETTIER_CHECK=(bunx prettier --check '*.md' 'docs/**/*.md' 'evals/**/*.md' 'crates/sharp/docs/**/*.md')
PRETTIER_LIST=(bunx prettier --list-different '*.md' 'docs/**/*.md' 'evals/**/*.md' 'crates/sharp/docs/**/*.md')

fail=0

pass() { printf 'PASS  %s\n' "$1"; }
note_fail() { printf 'FAIL  %s\n' "$1" >&2; fail=1; }

# assert_included <path>
# Proves the file is inside the checked set and not `.prettierignore`d.
# `prettier --list-different <single-file>` exits:
#   0  -> included and already formatted
#   1  -> included and would be reformatted (prints the path)
#   2  -> excluded or ignored ("No files matching the pattern ...")
assert_included() {
  local path="$1"
  local out rc
  set +e
  out=$("${PRETTIER_LIST[@]}" "$path" 2>&1)
  rc=$?
  set -e
  if [ "$rc" -eq 2 ] || printf '%s' "$out" | grep -qF "No files matching the pattern"; then
    note_fail "$path is excluded from the markdown prettier checked set (or .prettierignore'd)"
    return
  fi
  pass "$path is in the markdown prettier checked set"
}

# 1) Regression fixtures from the observed bypass instances must be inside the
#    checked set and not silently ignored.
assert_included "evals/scenarios/todo-app/README.md"
assert_included "workproduct-format-report.md"
assert_included "workproduct-format-research-prompt.md"

# 2) Zero-files guard: a known-bad fixture must produce a non-empty
#    --list-different output, so a glob matching nothing cannot report green.
TMP_MD="DOC_PRETTIER_SELFTEST_TEMP.md"
rm -f "$TMP_MD"
trap 'rm -f "$TMP_MD"' EXIT

# Deliberately unformatted markdown: inconsistent list indentation + trailing spaces.
cat > "$TMP_MD" <<'EOF'
#  Temporary prettier self-test fixture

-  misaligned item one
 - misaligned item two

paragraph with trailing whitespace   
another paragraph
EOF

list_out=$("${PRETTIER_LIST[@]}" "$TMP_MD" 2>&1) || true
if printf '%s' "$list_out" | grep -qF "$TMP_MD"; then
  pass "zero-files guard: --list-different reports the known-bad fixture ($TMP_MD)"
else
  note_fail "zero-files guard: --list-different did not report $TMP_MD"
  printf '  output:\n%s\n' "$list_out" | sed 's/^/    /' >&2
fi

# 3) Anti-bypass: the same prettier check that runs in CI must fail on the
#    deliberately unformatted file and must name it in the output.
set +e
check_out=$("${PRETTIER_CHECK[@]}" 2>&1)
check_rc=$?
set -e

if [ "$check_rc" -eq 0 ]; then
  note_fail "anti-bypass: prettier --check exited 0 despite the deliberately unformatted $TMP_MD"
elif printf '%s' "$check_out" | grep -qF "$TMP_MD"; then
  pass "anti-bypass: prettier --check failed and named $TMP_MD (exit $check_rc)"
else
  note_fail "anti-bypass: prettier --check failed but did not name $TMP_MD"
  printf '  output:\n%s\n' "$check_out" | sed 's/^/    /' >&2
fi

if [ "$fail" -ne 0 ]; then
  echo "SELFTEST FAILED" >&2
  exit 1
fi

echo "SELFTEST PASSED"
