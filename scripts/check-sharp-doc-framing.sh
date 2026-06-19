#!/usr/bin/env bash
# check-sharp-doc-framing.sh — Assert the Sharp doc set stays consolidated and
# framed around the semantic-independence thesis, per issue #726.
#
# Invariants (each a regression guard; any failure exits non-zero, failing CI):
#   1. No SQL/DDL anywhere under crates/sharp/docs — SQL is an implementation
#      concern of the swappable Postgres storage plugin, expressed conceptually
#      (field tables) even in postgres-storage-plugin.md, never as literal DDL.
#   2. The whitepaper H1 does NOT contain "database-native" — the thesis leads,
#      not the storage substrate.
#   3. The whitepaper H1 leads with the semantic/agent-first thesis.
#   4. Every relative markdown link under crates/sharp/docs resolves to a file
#      that exists (anchors stripped before the existence check).
#
# Modeled on scripts/check-doc-conformance.sh.
#
# Run locally:   scripts/check-sharp-doc-framing.sh
# Exits 0 when all checks pass, 1 otherwise.

set -uo pipefail

# Resolve repo root regardless of where the script is invoked from.
if ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" && [ -n "$ROOT" ]; then
  :
else
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
cd "$ROOT"

DOCS="crates/sharp/docs"
WHITEPAPER="$DOCS/whitepaper.md"

fail=0

pass() { printf 'PASS  %s\n' "$1"; }
note_fail() { printf 'FAIL  %s\n' "$1"; fail=1; }

# --- 1. No SQL/DDL anywhere under crates/sharp/docs --------------------------

sql_hits="$(grep -rniE '(^|[[:space:]])create table|insert into|select .*from |```[[:space:]]*sql' "$DOCS" || true)"
if [ -z "$sql_hits" ]; then
  pass "no SQL/DDL under $DOCS"
else
  note_fail "SQL/DDL found under $DOCS (move it to postgres-storage-plugin.md as field tables, not literal DDL):"
  printf '%s\n' "$sql_hits" | sed 's/^/        /'
fi

# --- 2. Whitepaper H1 does not contain "database-native" ---------------------

if grep -niE '^#[[:space:]].*database-native' "$WHITEPAPER" >/dev/null; then
  note_fail "whitepaper H1 still headlines 'database-native'"
else
  pass "whitepaper H1 does not contain 'database-native'"
fi

# --- 3. Whitepaper H1 leads with the semantic/agent-first thesis -------------

h1="$(grep -m1 -E '^#[[:space:]]' "$WHITEPAPER" || true)"
if printf '%s' "$h1" | grep -qiE 'semantic|agent-first'; then
  pass "whitepaper H1 leads with the semantic/agent-first thesis"
else
  note_fail "whitepaper H1 does not match /semantic|agent-first/i (got: ${h1:-<none>})"
fi

# --- 4. Relative markdown links resolve to existing files --------------------

dangling=0
# Find every relative link target of the form ](./...) or ](../...). The Python
# helper parses links per file so it can resolve targets relative to each file's
# own directory and strip #anchors before the existence check.
link_report="$(
  python3 - "$DOCS" <<'PY'
import os, re, sys

docs = sys.argv[1]
link_re = re.compile(r'\]\((\.\.?/[^)\s]+)\)')
bad = []
for dirpath, _dirs, files in os.walk(docs):
    for name in files:
        if not name.endswith(".md"):
            continue
        path = os.path.join(dirpath, name)
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        for m in link_re.finditer(text):
            target = m.group(1).split("#", 1)[0]
            if target == "":
                # pure in-page anchor like ](#section) — not a file link
                continue
            resolved = os.path.normpath(os.path.join(dirpath, target))
            if not os.path.exists(resolved):
                bad.append(f"{path} -> {m.group(1)} (resolved: {resolved})")

if bad:
    print("\n".join(bad))
    sys.exit(1)
sys.exit(0)
PY
)" || dangling=1

if [ "$dangling" -eq 0 ]; then
  pass "all relative markdown links under $DOCS resolve"
else
  note_fail "dangling relative markdown links under $DOCS:"
  printf '%s\n' "$link_report" | sed 's/^/        /'
fi

# ----------------------------------------------------------------------------

if [ "$fail" -ne 0 ]; then
  echo
  echo "Sharp doc-framing check FAILED — see issue #726."
  exit 1
fi

echo
echo "Sharp doc-framing check passed."
exit 0
