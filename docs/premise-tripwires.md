# Premise Tripwires — Flip Criteria for the "Seams Now, Serial Implementation" Seams

**Date:** 2026-07-03
**Status:** engineering hygiene — maintained alongside the seams
**Source:** [`code-reviews/2026-07-03-open-tensions-review.md`](./code-reviews/2026-07-03-open-tensions-review.md) findings T-9 / decision D-7 (adopted as hygiene default). Seam anatomy is documented in [`architecture.md`](./architecture.md) — §Gardening Loop Engine, §Seam: LoopHandle, §Sharp — Tier-1 Rust Semantic Merge (including the `projections` table), and §Outbound Notifications — `sf-notify`.

"Seams now, serial implementation" is honest engineering only if each seam carries a trigger condition. This page names, for each deliberately-serial seam: the **observable indicator** (measurable from the appliance's own telemetry — episodes, validation runs, analytics, queue depths — never from external benchmarks), the **flip criterion**, and **what gets re-implemented** when it fires. All numeric thresholds below are **initial proposals, not measured values**; the first act of maintaining this page is replacing them with numbers derived from dogfood telemetry.

## Seam A — Gardening loop: serial nine-step pass → DAG concurrency

- **Today:** the loop runs nine steps in a fixed serial order with a 60-second pause per pass (`architecture.md` §Gardening Loop Engine); steps that do not depend on each other still wait on each other.
- **Indicator:** per-step wall time split into LLM time vs. non-LLM time, from `sharp.episodes` durations and the per-step check-run events on `/analytics/check-runs/stream`; and the ratio of full-pass duration to the critical-path duration (the longest chain of genuinely dependent steps).
- **Flip criterion (initial proposal):** sustained model throughput/latency improvement such that, over a rolling two-week window of dogfood passes, the serial pass takes ≥2× the critical-path duration — i.e., the loop spends more time honoring an artificial ordering than doing dependent work.
- **What gets re-implemented:** the loop engine's scheduler — steps declared as a dependency DAG, independent steps fanned out concurrently onto fastenv, cursor-resume and `LoopHandle` drain/abort semantics extended from "current step" to "current frontier."

## Seam B — Merge gate: per-merge subprocess spawn → warm pools / incremental check / projections-default

- **Today:** each semantic merge spawns an analyzer subprocess (rust-analyzer / tsserver) and runs a full structural check; the `sharp.projections` table (continuous speculative merge results) exists but is lazily maintained, not the default path.
- **Indicator:** merge-gate latency (`forge.validation_runs` durations, episode timings) as a share of the total proposal cycle — specifically, whether a loop step's duration is dominated by non-LLM time.
- **Flip criterion (initial proposal):** over a rolling window, median merge-gate wall time exceeds median LLM time per proposal — the gate, not the model, is the iteration bottleneck. That is precisely the regime the sub-second-fastenv economics argument (tech-req §2.3) anticipates.
- **What gets re-implemented:** analyzer lifecycle becomes a warm pool (persistent, reused processes instead of per-merge spawn); structural verification goes incremental; `projections` becomes the default read path so Tier-1 merge results are precomputed rather than demanded.

## Seam C — Approval: per-change notification → batch approval API

- **Today:** `Notifier::notify_awaiting_approval` dispatches unconditionally per change entering `awaiting-approval` (`architecture.md` §Outbound Notifications); batch review is the ratified primary Studio mode, but the dispatch and approval surface are per-change.
- **Indicator:** awaiting-approval queue depth (count of changes in `ChangeState::AwaitingApproval`) and notifications per approver per day.
- **Flip criterion (initial proposal):** median queue depth sustained above ~10 over a week, or per-change notifications arriving faster than the approver's observed session cadence clears them — the notification stream has become noise and the per-change surface a treadmill. Note the ICP's approver is one part-time person (review T-3), so this tripwire is expected to fire early; it should be instrumented from the first install.
- **What gets re-implemented:** `sf-notify` dispatch policy (digest/summary instead of per-change), a batch approve/reject API, and the Studio batch-review surface presenting completed candidates side by side per PRD §5.

## Premise-regression tripwire — autonomy economics

The seams above assume the premise holds — model speed and reliability keep improving faster than their cost. The reverse tripwire guards against the premise regressing.

- **Indicator (all in-appliance):** cost per merged change (per-agent cost metering; `WorkSlot.costUsd` via `/analytics/slots`, summed over `sharp.episodes` per merged change), the approved-vs-proposed ratio, and the rollback rate of shipped corrections (PRD §2 counter-metrics), each on a rolling window.
- **Regression criterion (initial proposal):** cost per merged change trending up, or the approved-vs-proposed ratio trending down, across two consecutive windows — autonomy is getting more expensive or less trustworthy, not less and more.
- **Fallback posture:** keep the seams dormant (serial loop, per-change human gate stays primary); narrow the loop's autonomous scope to error-triage and human-stated intent (the below-signal-floor behavior); and lean the product story on sovereignty plus appliance operations rather than agent-cadence speed — the interim positioning the tensions review names as option (b) under T-9. No architecture is discarded; the flip criteria above simply do not fire, and this page records that they did not.

Ownership: this page changes in the same PR as any change to the seams it governs; a seam change without a tripwire update is drift.
