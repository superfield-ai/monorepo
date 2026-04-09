# Claude fixtures

Recorded `claude --print --output-format json` responses, replayed by
`replaySpawn` in integration tests. See `docs/testing.md` for the full strategy.

## Format

Each fixture is JSON shaped like the `AgentResult` interface (sessionId,
output, isError, costUsd) plus a `_metadata` object that documents how it
was captured. `replaySpawn` ignores `_metadata`.

## Recording

```bash
bun record-claude-fixtures <task-name> [--all]
```

Requires real Claude credentials. Refresh fixtures only when:

1. A prompt builder changes (record under a new fixture name)
2. Claude's CLI JSON output changes
3. The task's expected output schema changes

Never edit fixture files by hand.

## Naming convention

`<task>-<scenario>.json`, where `task` is the prompt builder name without
the `build` prefix and `Prompt` suffix:

- `issue-audit-conformant.json`
- `issue-audit-non-conformant.json`
- `blueprint-conformance-arch-violation.json`
- `feature-evaluate-new.json`
- `feature-evaluate-duplicate.json`
- `replan-evaluate-fresh.json`
- `doc-coverage-clean.json`
- `doc-canonical-sync-significant.json`
- `doc-consistency-clean.json`

## Blueprint integration fixtures (issue #82)

The following fixtures back the Layer-2 integration tests for the Blueprint
integration phase. **They were hand-authored on 2026-04-09** because the
recorder requires real Claude credentials and network access that were
unavailable in the worktree where this batch was added. Each fixture
carries `_metadata.hand_authored: true` so it is obvious. Refresh them by
running the recorder against a real Claude session — for example:

```bash
bun record-claude-fixtures blueprint-conformance-conformant --repo owner/repo --issue 10
bun record-claude-fixtures blueprint-conformance-violating --repo owner/repo --issue 10
bun record-claude-fixtures blueprint-self-audit-conformant --repo owner/repo --issue 10
bun record-claude-fixtures blueprint-self-audit-violating --repo owner/repo --issue 10
bun record-claude-fixtures feature-evaluate-exploratory
bun record-claude-fixtures feature-evaluate-narrowed
bun record-claude-fixtures feature-evaluate-duplicate
bun record-claude-fixtures dev-loop-first-turn --repo owner/repo --issue 10
bun record-claude-fixtures dev-loop-escalated --repo owner/repo --issue 10
```

Fixture names:

- `blueprint-conformance-conformant.json`
- `blueprint-conformance-violating.json`
- `blueprint-self-audit-conformant.json`
- `blueprint-self-audit-violating.json`
- `feature-evaluate-exploratory.json`
- `feature-evaluate-narrowed.json`
- `feature-evaluate-duplicate.json`
- `dev-loop-first-turn.json`
- `dev-loop-escalated.json`

The `test-sample.json` file is a synthetic fixture used only by the
`helpers/replay` unit tests; do not use it in real integration tests.

## Dev-loop e2e fixtures (issue #93)

Hand-authored fixtures backing the `tickDevLoop` happy-path e2e harness in
`packages/core/tests/integration/dev-loop.test.ts`. Live under
`tests/fixtures/claude/dev-loop-e2e/` and are referenced by
`replayDevLoopSpawn` as `dev-loop-e2e/<name>`:

- `dev-loop-e2e/develop-checklist-complete.json` — primary develop turn
  that reports the checklist complete and clears to the self-audit stage.
- `dev-loop-e2e/develop-needs-escalation.json` — primary develop turn 1
  that requests blueprint escalation via `needsBlueprintEscalation: true`.
  Used by the escalation + remediation e2e tests (#94) to drive the
  one-shot escalation latch across ticks.
