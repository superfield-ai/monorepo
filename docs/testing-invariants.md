<!--
DEV-SCOUT SKELETON (issue #772). Section headers + TODO placeholders only — no
prose. The four-invariant prose is filled by feature issue #768; the
subsystem-test-job-presence guardrail is feature issue #767. Do NOT write the
invariant prose in the scout pass.

═══ SCOUT NOTES: doc-conformance assertion insertion points (pinned for #768) ═══

The Doc Conformance workflow (.github/workflows/doc-conformance.yml, job
`doc-conformance`) runs scripts/check-doc-conformance.sh on every PR. That
script is the EXACT place feature #768 must add assertions that this file keeps
its four invariants — follow the existing pattern in that script:

  * Add a new `--- docs/testing-invariants.md ---` assertion block alongside the
    existing `--- docs/architecture.md ---` block.
  * Declare the path once near the top:  TESTING_INV="docs/testing-invariants.md"
  * Use the existing helpers `assert_match "<desc>" "<regex>" "$TESTING_INV"`
    (and `assert_absent` for anti-drift) — one assertion per invariant, e.g. one
    that the loud-skip section names #[ignore]/t.Skip()/skipif, one that the
    exit-0≠tested section names --no-tests=fail, one that the runtime-behaviour
    section forbids "doc-grep is coverage", one that the required-checks section
    names a per-language test-executing job. Each must FAIL LOUDLY if the
    invariant's key phrase regresses (matches the script's "reverted correction
    => red" contract).

Two complementary gates already cover this file and need no new wiring:
  * Prettier: the doc-conformance job runs `bunx prettier --check` on the Sharp
    doc set; this file is verified by `bunx prettier --check docs/testing-invariants.md`
    (issue #772 AC + test plan). Feature #768 should extend the doc-conformance
    job's prettier step glob to include docs/testing-invariants.md so formatting
    is enforced in CI too.

Cross-seam: scripts/check-test-job-presence.sh (stub, this same scout) is where
the subsystem-test-job-presence guardrail (#767) enforces invariant 4; it cites
coverage-truth.toml + scripts/check-coverage-truth.sh as the unit→test-job
mapping source. Keep invariant 4's prose here consistent with that guardrail.
-->

# Executed-Coverage Testing Invariants

<!-- TODO(#768): one-paragraph intro — why a green CI signal means "nobody
objected," not "the code ran." Cite the incident and _shared/test-coverage-policy.md. -->

## 1. Loud-skip, never silent-skip

<!-- TODO(#768): prose — a test needing an external resource (DB, model weights,
network) must FAIL in CI when the resource is absent, not skip. Name the silent-
skip antipatterns (#[ignore], t.Skip(), @Disabled, skipif(...), fixtures
returning None/nil). -->

## 2. Exit 0 ≠ tested

<!-- TODO(#768): prose — require evidence the diff was EXECUTED (>0 tests ran);
make "no tests collected" red (--no-tests=fail, --passWithNoTests=false,
--strict-markers). Cite the coverage-delta gate (scripts/check-coverage-delta.sh). -->

## 3. Runtime behaviour needs an executed-in-CI assertion

<!-- TODO(#768): prose — doc-grep, lint, type-check, and compile are NOT coverage
for a model/endpoint/migration/job. Runtime behaviour needs a test that actually
runs in CI. -->

## 4. Required checks must cover the languages present

<!-- TODO(#768): prose — every language present has a TEST-EXECUTING job in the
required branch-protection contexts, not just a build job. Cross-reference the
subsystem-test-job-presence guardrail (scripts/check-test-job-presence.sh, #767)
and the coverage-truth manifest. -->
