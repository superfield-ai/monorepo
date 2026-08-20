#!/usr/bin/env bash
# check-doc-prettier.sh — Markdown prettier coverage for doc-conformance.yml (issue #903).
#
# PURPOSE
#   The root `format:check` script no longer inspects markdown (it targets only
#   non-markdown source). Markdown formatting is therefore enforced here, in the
#   always-on Doc Conformance workflow, so a markdown-only PR cannot land an
#   unformatted `.md` file while the `Format` context is bypass-posted as a
#   skipped success.
#
# CHECKED SET
#   The checked set is explicit and must subsume every markdown file that is not
#   legitimately exempt via `.prettierignore`:
#     - *.md                       (repo root, e.g. workproduct-format-*.md)
#     - .agents/*.md               (agent instructions/warnings)
#     - docs/**/*.md               (all durable docs, including testing-invariants.md)
#     - evals/**/*.md              (eval scenarios and seeds, e.g. todo-app README)
#     - crates/**/docs/**/*.md     (per-crate doc sets, including Sharp and fastenv)
#     - crates/**/README.md        (crate READMEs)
#     - packages/*/README.md       (package READMEs)
#
# CI_WIRING
#   Run as a step in .github/workflows/doc-conformance.yml, which has NO paths
#   filter and therefore executes on markdown-only PRs.
#
# USAGE
#   scripts/check-doc-prettier.sh
#   Exits 0 when all checked markdown is formatted; non-zero otherwise.

set -euo pipefail

if ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" && [ -n "$ROOT" ]; then
  :
else
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
cd "$ROOT"

# Quoted globs are passed to Prettier so it resolves them (and so a zero-match
# glob fails loudly instead of being silently skipped).
bunx prettier --check \
  '*.md' \
  '.agents/*.md' \
  'docs/**/*.md' \
  'evals/**/*.md' \
  'crates/**/docs/**/*.md' \
  'crates/**/README.md' \
  'packages/*/README.md'
