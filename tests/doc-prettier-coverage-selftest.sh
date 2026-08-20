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
CHECKED_GLOBS=(
  '*.md'
  '.agents/*.md'
  'docs/**/*.md'
  'evals/**/*.md'
  'crates/**/docs/**/*.md'
  'crates/**/README.md'
  'packages/*/README.md'
)
PRETTIER_CHECK=(bunx prettier --check "${CHECKED_GLOBS[@]}")
PRETTIER_LIST=(bunx prettier --list-different "${CHECKED_GLOBS[@]}")

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

# 2) Coverage-completeness guard: every .md file in the repo must be either
#    inside the checked set or explicitly exempt via `.prettierignore`. A
#    markdown path outside both sets fails loudly rather than being silently
#    unchecked (issue #903).
set +e
coverage_out=$(python3 - "${CHECKED_GLOBS[@]}" <<'PY'
import fnmatch
import re
import sys
from pathlib import Path

checked_globs = sys.argv[1:]

def glob_to_regex(glob: str) -> re.Pattern[str]:
    parts = glob.split("/")
    regex_parts = ["^"]
    for i, part in enumerate(parts):
        if part == "**":
            if i == len(parts) - 1:
                regex_parts.append(".*")
            else:
                regex_parts.append("(?:.*/)?")
        elif "**" in part:
            raise ValueError(f"unsupported glob part: {part!r}")
        else:
            escaped = ""
            for c in part:
                if c == "*":
                    escaped += "[^/]*"
                elif c == "?":
                    escaped += "[^/]"
                else:
                    escaped += re.escape(c)
            regex_parts.append(escaped)
            if i < len(parts) - 1:
                regex_parts.append("/")
    regex_parts.append("$")
    return re.compile("".join(regex_parts))

glob_regexes = [glob_to_regex(g) for g in checked_globs]

def is_covered(path_str: str) -> bool:
    return any(r.match(path_str) for r in glob_regexes)

ignore_patterns = []
for line in Path(".prettierignore").read_text().splitlines():
    line = line.strip()
    if line and not line.startswith("#"):
        ignore_patterns.append(line.rstrip("/"))

def is_ignored(path_str: str) -> bool:
    for ig in ignore_patterns:
        if path_str == ig or path_str.startswith(ig + "/"):
            return True
        if fnmatch.fnmatch(path_str, ig):
            return True
    return False

uncovered = []
for p in sorted(Path(".").rglob("*.md")):
    sp = str(p)
    if any(part in sp for part in ["node_modules", ".git", "target", "dist"]):
        continue
    if is_covered(sp):
        continue
    if is_ignored(sp):
        continue
    uncovered.append(sp)

if uncovered:
    sys.stderr.write("FAIL  markdown files outside checked set and not .prettierignore'd:\n")
    for f in uncovered:
        sys.stderr.write(f"  - {f}\n")
    sys.exit(1)

print("PASS  coverage-completeness guard: every .md file is checked or explicitly ignored")
PY
)
coverage_rc=$?
set -e
if [ "$coverage_rc" -ne 0 ]; then
  printf '%s\n' "$coverage_out" >&2
  fail=1
else
  printf '%s\n' "$coverage_out"
fi

# 3) Zero-files guard: a known-bad fixture must produce a non-empty
#    --list-different output, so a glob matching nothing cannot masquerade as green.
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

# 4) Anti-bypass: the same prettier check that runs in CI must fail on the
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
