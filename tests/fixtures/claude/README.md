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

The `test-sample.json` file is a synthetic fixture used only by the
`helpers/replay` unit tests; do not use it in real integration tests.
