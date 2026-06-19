#!/usr/bin/env bash
# check-doc-conformance.sh — Assert docs/architecture.md and key in-code comments
# describe the running appliance accurately, per the 2026-06-18 conformance
# review (code-reviews/product-progress-2026-06-18T191613.md, issue #705).
#
# Each assertion below corresponds to a doc-drift correction. If any claim
# regresses (a corrected line is reverted), the matching check fails and the
# script exits non-zero, failing CI.
#
# Run locally:   scripts/check-doc-conformance.sh
# Exits 0 when all checks pass, 1 otherwise.

set -uo pipefail

# Resolve repo root regardless of where the script is invoked from.
if ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" && [ -n "$ROOT" ]; then
  :
else
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
cd "$ROOT"

ARCH="docs/architecture.md"
SF_LOOP_LIB="crates/sf-loop/src/lib.rs"
SF_PROJECT="crates/sf-serve/src/routes/project.rs"

fail=0

pass() { printf 'PASS  %s\n' "$1"; }
note_fail() { printf 'FAIL  %s\n' "$1"; fail=1; }

# Assert a grep pattern MATCHES in a file.
assert_match() {
  local desc="$1" pattern="$2" file="$3"
  if grep -niE "$pattern" "$file" >/dev/null; then
    pass "$desc"
  else
    note_fail "$desc (expected /$pattern/ to match in $file)"
  fi
}

# Assert a grep pattern does NOT match in a file.
assert_absent() {
  local desc="$1" pattern="$2" file="$3"
  if grep -niE "$pattern" "$file" >/dev/null; then
    note_fail "$desc (did not expect /$pattern/ to match in $file)"
  else
    pass "$desc"
  fi
}

# --- docs/architecture.md ----------------------------------------------------

# 1. Producerless analytics: slots and check-runs flagged as having no producer.
assert_match "analytics slots/check-runs flagged producerless" \
  "no producer|always empty|producerless" "$ARCH"

# 1b. The non-stream CI route GET /analytics/check-runs?sha= is documented in
#     the route table (issue #713) — assert the sha-keyed route marker is present.
assert_match "non-stream /analytics/check-runs?sha= route documented" \
  "check-runs\?sha=" "$ARCH"

# 2. Cluster events: v0 seeds status once at boot, no periodic poller.
assert_match "cluster events seed-once-at-boot caveat present" \
  "seed.*boot|once at boot|no .*poller" "$ARCH"

# 3. RLS paragraph names the k3s/TS-migrator track AND states the appliance
#    runner now applies/enforces it (issue #710 landed).
assert_match "RLS paragraph references k3s/migrator track" \
  "migrator|k3s" "$ARCH"
assert_match "RLS paragraph states appliance now enforces it" \
  "enforced on both deployment tracks|appliance .*(now denied|now applies|now enforced)|now denied by the database" \
  "$ARCH"

# 3b. RLS must NOT carry a bare unqualified "not yet implemented".
if grep -niE "RLS.*not yet implemented|not yet implemented.*RLS|row.?level security.*not yet implemented" "$ARCH" >/dev/null; then
  note_fail "RLS still has a bare unqualified 'not yet implemented' claim"
else
  pass "RLS has no bare unqualified 'not yet implemented' claim"
fi

# 4. Docker-era 'stops the container' phrasing is gone.
assert_absent "Docker-era 'stops the container' phrase removed" \
  "stops the container" "$ARCH"

# 5. Provisioner robustness documented (pg_ctl -l logfile, pg_database guard,
#    bin-dir auto-discovery).
assert_match "provisioner pg_ctl -l logfile documented" "pg_ctl -l" "$ARCH"
assert_match "provisioner pg_database guard documented" "pg_database" "$ARCH"
assert_match "provisioner bin-dir auto-discovery documented" \
  "detect_pg_bin_dir|bin dir|auto-discover" "$ARCH"

# 6. 'web' corpus documented as the canonical control-panel authoring corpus.
assert_match "'web' corpus documented as control-panel authoring corpus" \
  "web. corpus" "$ARCH"

# --- crates/sf-loop/src/lib.rs ----------------------------------------------

# 7. Loop header no longer says 'six' for the step count and references
#    ProjectGraphDerive.
assert_absent "sf-loop lib.rs no longer uses the word 'six'" "six" "$SF_LOOP_LIB"
assert_match "sf-loop lib.rs references ProjectGraphDerive" \
  "ProjectGraphDerive" "$SF_LOOP_LIB"

# --- crates/sf-serve/src/routes/project.rs ----------------------------------

# 8. project.rs comment no longer asserts it implements the /studio/issues
#    surface. It must explicitly disclaim ownership of that surface.
assert_match "project.rs disclaims implementing the /studio/issues surface" \
  "does NOT implement|empty seam|landed in" "$SF_PROJECT"

# ----------------------------------------------------------------------------

if [ "$fail" -ne 0 ]; then
  echo
  echo "Doc-conformance check FAILED — docs/architecture.md or an in-code comment"
  echo "has drifted from the running appliance. See issue #705."
  exit 1
fi

echo
echo "Doc-conformance check passed."
exit 0
