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
AGENT_ENSURE=".agents/agent-ensure-feature.md"
TESTING_INV="docs/testing-invariants.md"
AGENT_WARN=".agents/agent-warnings.md"
TODO_APP_README="evals/scenarios/todo-app/README.md"

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

# 2. Cluster events: a continuous health poller now drives mid-session
#    cluster-status transitions (issue #715 landed; the seed-once-at-boot
#    caveat is retired).
assert_match "cluster events continuous health poller documented" \
  "continuous health poller|continuous poller|run_cluster_status_poller" "$ARCH"

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

# --- governance tail (issues #716–#719) -------------------------------------

# 9. Auditor query surface: the read-only /studio/audit/decisions/{id} route,
#    gated to Owner/Auditor (#719).
assert_match "auditor query surface route documented" \
  "/studio/audit/decisions" "$ARCH"
assert_match "auditor surface gated to Owner/Auditor" \
  "Role::Auditor|Owner/Auditor" "$ARCH"

# 10. Policy engine: the drafted→active→revised→retired lifecycle and the
#     autonomous-vs-approval merge gate (#716). The change-lifecycle section
#     must no longer say the policy risk evaluation is 'tracked separately'.
assert_match "policy engine lifecycle documented" \
  "drafted .* active .* revised .* retired" "$ARCH"
assert_match "policy engine merge gate (autonomous vs approval) documented" \
  "MergeDecision|autonomous-versus-approval|autonomous vs approval|fail-closed" "$ARCH"
assert_absent "policy risk eval no longer claimed 'tracked separately'" \
  "policy risk evaluation .*tracked separately" "$ARCH"

# 11. Outbound notification channel sf-notify: always-on approval alert,
#     severity-gated signal alert, severity is NOT a runtime_signals column (#717).
assert_match "sf-notify NotificationChannel seam documented" \
  "NotificationChannel|sf-notify" "$ARCH"
assert_match "sf-notify notify_awaiting_approval / notify_signal documented" \
  "notify_awaiting_approval|notify_signal" "$ARCH"
assert_match "sf-notify severity is a notification-layer concept, not a signal column" \
  "not a signal-store column|not on Sharp.s .runtime_signals|notification-layer concept" "$ARCH"

# 12. Read-only systems-of-record connector seam: Connector trait, per-workspace
#     credentials, reference connector, structural read-only guarantee (#718).
assert_match "sf-connector Connector seam documented" \
  "sf-connector|Connector. trait" "$ARCH"
assert_match "sf-connector read-only by construction documented" \
  "read-only by construction|no .*write.*sync.* method|structural rather than" "$ARCH"
assert_match "sf-connector per-workspace credentials documented" \
  "ConnectorCredentials|per-workspace credential" "$ARCH"

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

# --- .agents/agent-ensure-feature.md (issue #763) ---------------------------

# 13. The nexum embedder must NOT be verified by a manual local command. The
#     embedder-coverage CI job (#760) executes its #[ignore]d tests via
#     --include-ignored; agent-ensure-feature.md must point at that job, not
#     instruct a hand-run `cargo test -p nexum … --ignored`. This closes the
#     gap (#763) that let the embedder merge unexecuted.
# The manual form is `cargo test … -p nexum … -- --ignored`. The CI-backed
# form is `-- --include-ignored`, so the ` -- +--ignored` separator (a bare
# `--ignored`, not `--include-ignored`) uniquely flags the regressed manual
# command and never matches the legitimate CI reference.
assert_absent "agent-ensure-feature.md has no manual nexum embedder verify" \
  "cargo test .*-p nexum.* -- +--ignored" "$AGENT_ENSURE"
assert_match "agent-ensure-feature.md points at the CI-backed embedder job" \
  "nexum embedder coverage|cargo test -p nexum --test integration -- --include-ignored" \
  "$AGENT_ENSURE"

# --- docs/testing-invariants.md + .agents/agent-warnings.md (issue #768) -----

# The four executed-coverage testing invariants must be recorded — in full and
# by name — in BOTH the durable doc and the agent-warnings nag list. Each pair
# of assertions fails LOUDLY if an invariant's heading or its decisive key
# phrase is removed from either file, so the policy cannot silently rot.
# (Canonical wording: _shared/test-coverage-policy.md; CLAUDE.md "Test-coverage
# invariants".)

# Invariant 1 — Loud-skip, never silent-skip (names the silent-skip antipatterns).
assert_match "INV1 loud-skip-never-silent-skip named (testing-invariants)" \
  "loud-skip, never silent-skip" "$TESTING_INV"
assert_match "INV1 loud-skip-never-silent-skip named (agent-warnings)" \
  "loud-skip, never silent-skip" "$AGENT_WARN"
assert_match "INV1 names the silent-skip antipattern t.Skip() (testing-invariants)" \
  "t\.Skip\(\)" "$TESTING_INV"
assert_match "INV1 names the silent-skip antipattern t.Skip() (agent-warnings)" \
  "t\.Skip\(\)" "$AGENT_WARN"

# Invariant 2 — Exit 0 ≠ tested (names the no-tests-collected-is-red convention).
assert_match "INV2 exit-0-not-tested named (testing-invariants)" \
  "exit 0 ≠ tested" "$TESTING_INV"
assert_match "INV2 exit-0-not-tested named (agent-warnings)" \
  "exit 0 ≠ tested" "$AGENT_WARN"
assert_match "INV2 names --no-tests=fail (testing-invariants)" \
  "no-tests=fail" "$TESTING_INV"
assert_match "INV2 names --no-tests=fail (agent-warnings)" \
  "no-tests=fail" "$AGENT_WARN"

# Invariant 3 — Runtime behaviour needs an executed-in-CI assertion (doc-grep is
# NOT coverage).
assert_match "INV3 runtime-behaviour-needs-executed-assertion named (testing-invariants)" \
  "runtime behaviour needs an executed-in-CI assertion" "$TESTING_INV"
assert_match "INV3 runtime-behaviour-needs-executed-assertion named (agent-warnings)" \
  "runtime behaviour needs an executed-in-CI assertion" "$AGENT_WARN"
assert_match "INV3 states doc-grep/lint/compile are not coverage (testing-invariants)" \
  "are \*\*not\*\* coverage" "$TESTING_INV"
assert_match "INV3 states doc-grep/lint/compile are not coverage (agent-warnings)" \
  "are \*\*not\*\* coverage" "$AGENT_WARN"

# Invariant 4 — Required checks must cover the languages present (a per-language
# test-executing job in the required contexts).
assert_match "INV4 required-checks-cover-languages named (testing-invariants)" \
  "required checks must cover the languages present" "$TESTING_INV"
assert_match "INV4 required-checks-cover-languages named (agent-warnings)" \
  "required checks must cover the languages present" "$AGENT_WARN"
assert_match "INV4 names a per-language test-executing job (testing-invariants)" \
  "test-executing.*job" "$TESTING_INV"
assert_match "INV4 names a per-language test-executing job (agent-warnings)" \
  "test-executing.*job" "$AGENT_WARN"

# --- Curated rust-test-seam filterset exclusion + --workspace over-claim (#789)
# The stranded knowledge-capture (#789) must stay durable in the agent-warnings
# nag list, so the curated-filterset exclusion and the check-coverage-truth.sh
# `--workspace` over-claim risk cannot silently rot back to ephemeral local
# state. Each assertion fails LOUDLY if its decisive phrase is removed.
assert_match "curated nextest filterset exclusion named (agent-warnings)" \
  "Curated nextest filterset hides a real DB-test failure class" "$AGENT_WARN"
assert_match "curated filterset names the workspace_id schema gap (agent-warnings)" \
  "workspace_id.*NOT-NULL/FK back-fill" "$AGENT_WARN"
assert_match "curated filterset documents re-inclusion conditions (agent-warnings)" \
  "Re-inclusion conditions" "$AGENT_WARN"
assert_match "check-coverage-truth.sh --workspace over-claim risk named (agent-warnings)" \
  "check-coverage-truth.sh.*over-claim risk" "$AGENT_WARN"

# --- evals/scenarios/todo-app/README.md (issue #906) ------------------------

# The README must not claim the scenario is documentation-only / has no runner.
assert_absent "todo-app README stale banner removed" \
  "Documentation only|no runner code.*exists yet" "$TODO_APP_README"

# The README must name the unauthenticated GET / placeholder surface that the
# browser-smoke screenshot actually captures, so it does not over-claim Studio UI
# coverage (issue #906).
assert_match "todo-app README names unauthenticated placeholder surface" \
  "unauthenticated \`GET /\` placeholder surface" "$TODO_APP_README"

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
