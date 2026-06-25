#!/usr/bin/env bash
# check-test-job-presence.sh — subsystem-test-job-presence guardrail (STUB).
#
# ============================================================================
# DEV-SCOUT STUB (issue #772). This is a no-op that exits 0. It exists only to
# PIN THE SEAM so the real guardrail (issue #767) can be developed in parallel
# with the four-invariant docs (issue #768) without colliding. Do NOT add real
# logic here in the scout pass — see the TODO(#767) anchor below.
# ============================================================================
#
# WHAT THE REAL GUARDRAIL MUST ENFORCE (feature #767 — out of scope here)
#   Invariant 4 of the test-coverage policy ("required checks must cover the
#   languages present") at SUBSYSTEM granularity: every subsystem/unit that
#   exists on disk must have at least one *test-executing* CI job in the
#   REQUIRED branch-protection contexts. A subsystem that ships with only a
#   build/compile/lint job — and no job that actually RUNS its tests — must
#   make this check exit non-zero (RED), never a silent green.
#
# ── COVERAGE-TRUTH UNIT→TEST-JOB MAPPING SOURCE (the seam this stub pins) ─────
#   The authoritative mapping from a subsystem/unit to "which CI job executes
#   its tests" already exists and MUST be the single source of truth the real
#   guardrail reads — do not re-derive it independently:
#
#   1. coverage-truth.toml (repo root) — the per-unit manifest. One [[unit]]
#      row per directory under crates/* and packages/*, each carrying
#      `tests_executed_in_ci` (int): 0 == no CI job runs this unit's tests,
#      >0 == at least one job does. This is the canonical inventory of which
#      units are EXECUTED vs merely compiled.
#
#   2. scripts/check-coverage-truth.sh (issue #759; wired as the `coverage-truth`
#      job in .github/workflows/build.yml) — the validator that derives the
#      unit→executing-job reality DIRECTLY from the workflows + filesystem and
#      asserts the manifest matches. Its reality-derivation is the exact
#      mapping logic the presence guardrail should reuse:
#        * a CRATE is executed iff a workflow RUNS its tests — parsed from
#          embedder-coverage.yml (`cargo test -p <crate>`, issue #760) OR
#          rust.yml's DB-gated nextest job (`cargo nextest run -p <crate>`,
#          issue #765) — the job `name:` "Rust workspace tests (nextest,
#          no-tests=fail)" / "Rust test seam" lines in .github/workflows/rust.yml.
#        * a PACKAGE is executed iff it has *.test.ts under tests/unit or
#          tests/integration (the test-unit / test-integration globs).
#
#   3. scripts/check-coverage-delta.sh (issue #766/#783; the `coverage-delta`
#      required job in rust.yml) — maps each touched `crates/<dir>/...` path to
#      its owning Cargo package via `crates/<dir>/Cargo.toml` `name`, then
#      consumes the nextest libtest-json NDJSON per-package executed-count map.
#      This crates/<dir>→Cargo-package resolution is the same identity the
#      presence guardrail needs to name "which job covers package X".
#
#   In short: coverage-truth.toml says WHICH units must be executed;
#   check-coverage-truth.sh derives WHICH job executes each unit; the presence
#   guardrail (#767) layers on top to assert that executing job is a REQUIRED
#   branch-protection context (not merely present in some non-required workflow).
#
# CANONICAL DOCS
#   docs/prd.md — product requirements.
#   docs/testing-invariants.md — the four-invariant reference (skeleton pinned
#     by this same scout; prose filled by issue #768).
#   _shared/test-coverage-policy.md — the four invariants this guardrail serves:
#     (1) loud-skip-never-silent-skip, (2) exit-0≠tested,
#     (3) runtime-behaviour-needs-executed-assertion,
#     (4) required-checks-cover-languages-present (THIS guardrail enforces #4 at
#     subsystem granularity).
#
# USAGE (once implemented by #767)
#   scripts/check-test-job-presence.sh
#   Exit 0 when every on-disk subsystem has a test-executing REQUIRED job;
#   non-zero (listing each uncovered subsystem) otherwise.

set -euo pipefail

# TODO(#767): replace this no-op with the real subsystem-test-job-presence
# guardrail. Read the unit inventory from coverage-truth.toml, reuse the
# unit→executing-job mapping derived by scripts/check-coverage-truth.sh, and
# assert each subsystem's executing job is a REQUIRED branch-protection context.
# Until then this stub is intentionally a no-op so the seam compiles green.
echo "check-test-job-presence.sh: dev-scout stub (#772) — no-op, pending #767."
exit 0
