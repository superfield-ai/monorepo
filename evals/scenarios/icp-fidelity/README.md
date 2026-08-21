# Scenario: icp-fidelity

> **Documentation + grader-level unit coverage only** (issue #865). The Tier-2
> nightly harness that executes this scenario end to end against a live
> appliance — the workflow, a scripted approval actor, appliance boot, and
> nightly scheduling — is a sibling feature (docs/eval-design.md sequencing
> item 2, issues #863/#864) and is out of scope here.

## Goal

Prove **ICP fidelity**, not just loop plumbing: given a seed intent voiced by
a non-engineer operator (see [`seed/icp-seed.md`](./seed/icp-seed.md)) — the
target customer described in `docs/prd.md` §3 (>$10M revenue, no full-time
engineers, a sysadmin-grade technical lead) — the loop installs under the
**fail-closed** default policy (`crates/sf-db/src/policy.rs` returns
`MergeDecision::RequiresApproval` for every change when no policy is active)
and exercises **outcome-level approval** end to end: the change reaches
`awaiting-approval`, and only a recorded human approval moves it to `merged`
(`docs/prd.md:156`, approvers judge behavior, never diffs).

This is the evidence backing the PRD's time-to-first-app metric
(`docs/prd.md:42`): a run only counts if the install policy actually held,
not merely if an app got built.

## Inputs

- **Seed intent** — [`seed/icp-seed.md`](./seed/icp-seed.md): a vendor-onboarding
  tracker request, written the way an operations lead (not an engineer) would
  write it — no code, schema, or framework vocabulary, and an explicit ask for
  a human approval gate before anything ships.

## Acceptance bar

Defined in [`acceptance.md`](./acceptance.md): `rung1 (install-policy
fail-closed) AND rung2 (outcome approval)`. Both rungs gate; there is no
observed-only leg.

## How it runs

Executed by the same [`live` runner](../../runners/live.md) shape as
`todo-app` (seed → serve → poll → grade), with the fail-closed default policy
left untouched — no pre-activated policy — and a scripted approval actor
(sibling feature, out of scope here) recording the approval at the
`awaiting-approval` change. The scenario itself is data only: the seed intent
and the acceptance bar.

## Grading

Grading flows through the same green/red verdict machinery as `todo-app`:
`evaluate_run` folds per-rung grader verdicts into `result.json` with
`accepted == all gating rungs pass`. A run where the policy gate was stubbed,
bypassed, or where a change merged without an approval record grades red. See
[`crates/sf-eval/src/graders.rs`](../../../crates/sf-eval/src/graders.rs) for
the pure grader functions and
[`crates/sf-eval/src/result.rs`](../../../crates/sf-eval/src/result.rs) for
the `IcpFidelityAcceptance` accept-rule shape (the icp-fidelity analog of
`todo-app`'s `Acceptance`; `todo-app`'s `Acceptance`/`RunResult`/`evaluate_run`
are unchanged).

## Bounded-claims note

This scenario produces eval evidence for the install-policy and approval-flow
behaviors described above — it is not a usage-derived-spec claim and does not
assert that user outcomes in general are verified (bounded-claims gate P-3,
`docs/eval-design.md` sequencing bind).
