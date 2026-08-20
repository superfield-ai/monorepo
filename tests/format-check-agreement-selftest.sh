#!/usr/bin/env bash
# format-check-agreement-selftest.sh — assert `format:check` and its producing
# workflow's paths-ignore agree on markdown (issue #903).
#
# PURPOSE
#   The bypass class this issue closes is markdown-only PRs getting a green
#   `Format` status while prettier never inspected the changed `.md` files. This
#   self-test verifies that agreement cannot silently regress: if
#   `.github/workflows/build.yml` path-ignores `**/*.md`, the root
#   `format:check` script must not include markdown in the path set it checks.
#
# WHAT IT CHECKS
#   - build.yml's `pull_request.paths-ignore` contains `**/*.md`.
#   - package.json's `format:check` command does not check `.` (which would
#     include markdown) and does not include any un-negated `*.md` / `*.mdx`
#     glob.
#
# USAGE
#   tests/format-check-agreement-selftest.sh
#   Exits 0 iff the agreement holds; non-zero otherwise.

set -euo pipefail

if ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" && [ -n "$ROOT" ]; then
  :
else
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
cd "$ROOT"

PACKAGE_JSON="${AGREEMENT_PACKAGE_JSON:-package.json}"
BUILD_WF=".github/workflows/build.yml"

if [ ! -f "$PACKAGE_JSON" ]; then
  echo "FAIL  package.json not found: $PACKAGE_JSON" >&2
  exit 1
fi
if [ ! -f "$BUILD_WF" ]; then
  echo "FAIL  build workflow not found: $BUILD_WF" >&2
  exit 1
fi
if ! python3 -c 'import yaml' >/dev/null 2>&1; then
  echo "FAIL  PyYAML is required to run this self-test" >&2
  exit 1
fi

# The agreement check is implemented in Python so it can tokenise the npm script
# with shlex and parse build.yml with PyYAML.
python3 - "$PACKAGE_JSON" "$BUILD_WF" <<'PY'
import json
import re
import shlex
import sys
import yaml

package_path, build_wf_path = sys.argv[1:3]

with open(package_path, "r", encoding="utf-8") as fh:
    package = json.load(fh)

format_cmd = package.get("scripts", {}).get("format:check", "")
if not format_cmd:
    sys.stderr.write("FAIL  package.json has no format:check script\n")
    sys.exit(1)

try:
    tokens = shlex.split(format_cmd)
except ValueError as exc:
    sys.stderr.write(f"FAIL  cannot parse format:check command: {exc}\n")
    sys.exit(1)

with open(build_wf_path, "r", encoding="utf-8") as fh:
    build_wf = yaml.safe_load(fh)

on_block = build_wf.get("on", build_wf.get(True, {}))
pr_trigger = on_block.get("pull_request", {}) if isinstance(on_block, dict) else {}
if not isinstance(pr_trigger, dict):
    pr_trigger = {}
paths_ignore = pr_trigger.get("paths-ignore", []) or []

errors = []

if "**/*.md" not in paths_ignore:
    errors.append("build.yml pull_request.paths-ignore does not contain '**/*.md'")

# Walk tokens, skipping options and their values, looking for path/glob arguments.
i = 0
path_tokens = []
while i < len(tokens):
    tok = tokens[i]
    if tok.startswith("-"):
        # Skip the option and, if it takes a value, the next token too.
        # The options we care about here are all single-argument.
        if tok in ("--config", "--ignore-path", "--plugin"):
            i += 2
            continue
        i += 1
        continue
    path_tokens.append(tok)
    i += 1

for tok in path_tokens:
    # A negated glob ("!**/*.md") is an exclusion, not coverage.
    if tok.startswith("!"):
        continue
    # A bare '.' or './' coverage set includes markdown -> disagreement.
    if tok == "." or tok == "./":
        errors.append(
            f"format:check covers '.' (the whole tree), which includes markdown "
            f"while build.yml ignores '**/*.md'"
        )
        continue
    # Any un-negated markdown glob is direct disagreement.
    if re.search(r"\.mdx?(?:\b|$)", tok):
        errors.append(
            f"format:check includes an un-negated markdown glob: {tok}"
        )

if errors:
    sys.stderr.write("FAIL  format:check / build.yml paths-ignore agreement broken:\n")
    for e in errors:
        sys.stderr.write(f"  - {e}\n")
    sys.exit(1)

print(f"PASS  format:check agrees with build.yml paths-ignore on markdown")
PY

# Mutation test: tamper with the package.json to reintroduce the disagreement
# (whole-tree prettier --check .) and prove the check above rejects it.
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT
cp "$PACKAGE_JSON" "$TMPDIR/package.json"
python3 - "$TMPDIR/package.json" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as fh:
    pkg = json.load(fh)
pkg["scripts"]["format:check"] = "bunx prettier --check ."
with open(path, "w", encoding="utf-8") as fh:
    json.dump(pkg, fh, indent=2)
    fh.write("\n")
PY

if AGREEMENT_PACKAGE_JSON="$TMPDIR/package.json" "$0" >/dev/null 2>&1; then
  echo "FAIL  mutation test: the agreement check should have rejected 'prettier --check .'" >&2
  exit 1
else
  echo "PASS  mutation test: agreement check correctly rejects whole-tree prettier --check ."
fi
