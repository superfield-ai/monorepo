# Planning Loop Healing Task List

## Goal

Finish the planning-loop redesign so the loop can:

- repair malformed issue bodies instead of only commenting on them
- improve issue quality when features or test plans are vague
- place newly opened issues into phases without crashing when `## Phase` is missing
- keep operator logs and tests aligned with the new behavior

## Current gap summary

- `packages/core/prompts/issue-audit.ts` has already been upgraded to a batched remediation prompt.
- `packages/core/prompts/plan-placement.ts` exists, but nothing calls it yet.
- `packages/core/steps/issue-audit.ts` still executes one issue per LLM call and expects the old single-report schema.
- `packages/core/steps/plan-coverage.ts` still throws when an issue lacks `## Phase`.
- `packages/core/loop.ts` still reports the old issue-audit / plan-coverage outcomes.
- Tests and docs still describe the older advisory-only planning behavior.

## Implementation plan

### Phase 1: Wire batched issue remediation

- [x] Replace the old single-issue `IssueAuditReport` parsing in `packages/core/steps/issue-audit.ts` with batched `reports[]` parsing.
- [x] Extend the audit result types to capture `quality_issues` and `proposed_body`.
- [x] Change the step from “post findings comment” to “update the issue body when non-conformant”.
- [x] Preserve label behavior:
      `non-conformant` should still be added when remediation is needed and removed once the issue is conformant.
- [x] Decide and implement whether the audit comment should be removed entirely or kept only for infrastructure failures.
- [x] Keep bounded concurrency, but make each spawn process a batch of issues instead of one issue.

Acceptance criteria:

- Non-conformant issues are rewritten via `updateIssueBody`.
- Conformant issues are left unchanged.
- The returned result cleanly separates conformant vs non-conformant issue numbers.

### Phase 2: Add LLM-assisted plan placement

- [x] Add a new planning step implementation that calls `buildPlanPlacementPrompt` for uncovered issues missing usable phase placement.
- [x] Decide whether this becomes:
      a helper inside `plan-coverage.ts`, or a separate `steps/plan-placement.ts` invoked by `loop.ts`.
- [x] Preserve deterministic placement for issues that already have a valid `## Phase`.
- [x] Support creating new phases when the model marks `create_phase: true`.
- [x] Validate LLM output:
      every issue appears exactly once, new phases have goals, existing phases match exactly.
- [x] Reject illegal placements cleanly and log actionable errors.

Acceptance criteria:

- Missing-`## Phase` issues no longer crash plan coverage.
- Related unplanned issues can be grouped into the same newly created phase.
- Existing conformant issues still flow through deterministic placement.

### Phase 3: Rework plan-coverage flow

- [x] Refactor `packages/core/steps/plan-coverage.ts` to separate:
      deterministic coverage, LLM-assisted placement input collection, phase creation, and final append ordering.
- [x] Return richer result metadata such as:
      `appended`, `alreadyCovered`, `skipped`, `llmPlaced`, `createdPhases`, `planCreated`.
- [x] Keep scout-first ordering and scout-gate dependency behavior intact.
- [x] Make failure modes explicit:
      invalid placement, conflicting scout gate, missing phase goal, duplicate issue mapping.

Acceptance criteria:

- `runPlanCoverage` is resilient to malformed issues.
- Coverage result gives enough detail for useful loop logging.

### Phase 4: Update planning-loop orchestration and logs

- [x] Update `packages/core/loop.ts` to consume the new audit result shape.
- [x] Log how many issues were remediated, skipped, appended, phase-assigned by LLM, and deferred.
- [ ] Keep rate-limit short-circuit behavior intact.
- [ ] Ensure blueprint-conformance still runs on the post-remediation issue bodies in the next appropriate tick.

Acceptance criteria:

- Operator logs reflect remediation and placement activity without needing GitHub inspection.

### Phase 5: Tests

- [x] Rewrite `packages/core/tests/unit/issue-audit.test.ts` for batched responses and `proposed_body` handling.
- [x] Add unit tests for malformed `reports[]` payloads, missing `proposed_body`, and mixed conformant/non-conformant batches.
- [ ] Add unit tests for LLM-assisted phase placement validation.
- [x] Add unit tests for `plan-coverage.ts` covering:
      missing `## Phase`, new phase creation, grouped placements, and scout-gate conflicts.
- [ ] Update any prompt snapshot tests affected by the new prompt files or contracts.
- [ ] Run targeted unit tests, then full unit suite.

### Phase 6: Docs

- [ ] Update `docs/architecture.md` to describe issue remediation instead of advisory-only schema comments.
- [ ] Update `docs/plan.md` so the completed roadmap snapshot does not imply the old behavior is final.
- [ ] Add a short note in testing/docs about new fixtures needed for batched issue-audit and plan-placement.

## Recommended execution order

1. Finish `issue-audit.ts` batching and body remediation.
2. Introduce validated plan-placement step.
3. Refactor `plan-coverage.ts` around the new placement flow.
4. Update `loop.ts` logging and result wiring.
5. Backfill tests.
6. Refresh docs.

## Risks to watch

- Rewriting issue bodies too aggressively and losing valid user-authored content.
- Letting the LLM create noisy or duplicate phase names.
- Breaking scout-gate semantics when creating a new phase around a `dev-scout` issue.
- Making the loop non-idempotent across repeated ticks.

## Definition of done

- The planning loop can take malformed issues, rewrite them into the expected schema, and place them into the plan without aborting the tick.
- New behavior is covered by unit tests.
- Logs make the remediation and placement decisions obvious.
