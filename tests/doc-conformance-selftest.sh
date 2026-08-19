#!/usr/bin/env bash
# tests/doc-conformance-selftest.sh — executed negative check for issue #906.
#
# Copies the asserted doc set into a temp tree, reintroduces the stale README
# banner, removes the unauthenticated-placeholder sentence, and asserts that
# scripts/check-doc-conformance.sh fails loudly and names each failing
# assertion. Also cross-checks the workflow source of truth so the README claim
# is updated if the eval job ever starts rendering the authenticated Studio UI.
#
# Wired into .github/workflows/doc-conformance.yml; runs in CI on every PR.

set -euo pipefail

# Resolve repo root from the script location so the self-test runs correctly in
# CI containers (including shallow checkouts) even if git's top-level lookup
# is momentarily unavailable.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

README="evals/scenarios/todo-app/README.md"
WORKFLOW=".github/workflows/eval-todo-app.yml"
SCRIPT="scripts/check-doc-conformance.sh"

# Copy the working tree into a temp tree, then mutate only the README. We avoid
# git commands here because CI containers may flag the checkout as a dubious
# ownership repository, which would make `git ls-files` fail before we can use
# it. The temp tree is not a git repo, so check-doc-conformance.sh resolves its
# root from $(dirname "$0")/.., i.e. the temp tree itself.
TMP_TREE="$TMP/tree"
mkdir -p "$TMP_TREE"
find . -mindepth 1 -maxdepth 1 -not -name '.git' -exec cp -a {} "$TMP_TREE/" \;

# Zero-assertions guard: the asserted file must exist in the temp tree.
if [ ! -f "$TMP_TREE/$README" ]; then
  echo "ERROR: temp copy of $README missing" >&2
  exit 1
fi

# Reintroduce the stale banner (issue #906a): replace the first 5 lines with the
# old text. This must trigger the assert_absent check.
{
  printf '> **Documentation only.** This is the spec for the first scenario; no runner code\n> exists yet. It is the concrete instance of the Tier-2 scenario eval in\n> [`docs/eval-design.md`](../../../docs/eval-design.md).\n\n'
  tail -n +6 "$TMP_TREE/$README"
} > "$TMP_TREE/$README.new"
mv "$TMP_TREE/$README.new" "$TMP_TREE/$README"

# Remove the unauthenticated-placeholder sentence (issue #906b). This must
# trigger the assert_match check.
sed -i '/unauthenticated `GET \/` placeholder surface/d' "$TMP_TREE/$README"

# Run the conformance script against the temp tree.
echo "Running scripts/check-doc-conformance.sh against regressed temp tree..."
set +e
(cd "$TMP_TREE" && bash "$SCRIPT") > "$TMP/out.txt" 2>&1
status=$?
set -e

cat "$TMP/out.txt"

# The conformance check must fail against the regressed README.
if [ "$status" -eq 0 ]; then
  echo "ERROR: check-doc-conformance.sh passed against regressed README" >&2
  exit 1
fi

# Zero-assertions guard: both new assertions must appear by name in the output,
# proving they executed and were not silently skipped or typo'd.
grep -F "todo-app README stale banner removed" "$TMP/out.txt" >/dev/null
grep -F "todo-app README names unauthenticated placeholder surface" "$TMP/out.txt" >/dev/null

# The failure output must name the regressed phrasing.
grep -iE "Documentation only|no runner code|exists yet" "$TMP/out.txt" >/dev/null
grep -iE "unauthenticated.*placeholder|placeholder.*unauthenticated" "$TMP/out.txt" >/dev/null

# Source-of-truth cross-check: the real workflow still captures the
# unauthenticated placeholder surface and still does not set CONTROL_ASSETS_DIR.
# If this ever changes, the README claim must be updated rather than pinned.
if ! grep -F 'http://127.0.0.1:7000/' "$WORKFLOW" >/dev/null; then
  echo "ERROR: eval-todo-app.yml no longer captures http://127.0.0.1:7000/; update README claim" >&2
  exit 1
fi
# Ignore comment-only mentions; the README claim is only false if the variable is
# actually set in the job.
if grep -v '^[[:space:]]*#' "$WORKFLOW" | grep -F 'CONTROL_ASSETS_DIR' >/dev/null; then
  echo "ERROR: eval-todo-app.yml now sets CONTROL_ASSETS_DIR; update README claim" >&2
  exit 1
fi

echo "doc-conformance self-test passed"
