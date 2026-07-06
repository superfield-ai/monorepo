# Grader: install-policy-fail-closed

> Reusable check. Asks: **did the fail-closed install policy hold for every
> merged change in the run?** Used by `icp-fidelity` as rung 1.

## Background

A fresh Superfield appliance ships with no active policy. The policy engine
(`crates/sf-db/src/policy.rs`, `Policy::evaluate` /
`evaluate_change_against_active_policy`) is fail-closed by construction: when
no policy is `active`, every change gets `MergeDecision::RequiresApproval` —
a missing policy must never silently grant autonomy. A change can only merge
after passing through the `awaiting-approval` change-lifecycle state
(`crates/sf-db/src/change.rs`; `* → merged` is only legal from
`awaiting-approval`).

This grader asks whether that held for every change the run actually merged:
no merged change may have bypassed `awaiting-approval`, and no merged change
may have been produced under a policy-granted `MergeDecision::Autonomous`
(i.e. a permissive policy was pre-activated on the fresh appliance, which
itself would be a fail-closed-default violation worth catching even though it
is not the scenario's primary path).

## Verdict

PASS when, for every change the run recorded as `merged`:

- its state history includes an `awaiting-approval` entry, **and**
- the `MergeDecision` the policy engine returned for it was
  `RequiresApproval` (never `Autonomous`).

Vacuously PASS when the run merged no changes (see the scenario's
`acceptance.md` for why rung 2 exists to catch that case).

FAIL otherwise — naming which merged change bypassed the gate.

## Notes / rough edges

- This grader does not re-derive the policy decision; it consumes whatever
  `MergeDecision` the real policy engine produced for the run (or, if the run
  activated a policy at all, that is itself worth flagging — the scenario's
  seed intent never asks for autonomous shipping).
- Structural bypass (a merged change with no recorded `awaiting-approval`
  transition) would indicate either a change-lifecycle bug or direct database
  tampering; either way this grader treats it as a hard fail rather than an
  edge case to special-case away.
