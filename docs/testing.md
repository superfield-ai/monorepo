# Testing Framework

Superfield's runtime spawns an agent CLI as a subprocess. Real end-to-end
tests against vendor CLIs are slow, expensive, non-deterministic, and require
credentials in CI. This document describes the three-layer test strategy that
keeps the codebase well-tested without paying that price on every commit.

## Three layers

| Layer                               | Speed      | Determinism | Cost   | Coverage       | When it runs          |
| ----------------------------------- | ---------- | ----------- | ------ | -------------- | --------------------- |
| 1. Unit + injected fake             | ms         | total       | $0     | Per-function   | Every PR              |
| 2. Integration with replay fixtures | sub-second | total       | $0     | Cross-module   | Every PR              |
| 3. Live smoke against vendor CLI    | minutes    | low         | real $ | Contract drift | Nightly / pre-release |

### Layer 1 — Unit tests with injected fake spawn

Every function that calls `spawnAgent` accepts an `opts.spawn` override. Unit
tests pass a function returning a canned `AgentResult` and assert against the
function's behaviour. The LLM is the only thing faked — Plan parser, GitHub
API (via MSW), worktree manager, session CRUD, prompt builders, and validators
all run for real.

**What it catches:** orchestration bugs, parser errors, JSON shape mismatches,
state-machine errors, GitHub API misuse.

**What it does NOT catch:** prompt drift, real response shape changes,
real CLI flag drift.

**Helper:** `packages/core/tests/helpers/fake-spawn.ts`

```typescript
import { fakeSpawn } from "./helpers/fake-spawn.ts";

// Issue audit: the LLM returns a batch response covering all issues in the batch
const spawn = fakeSpawn({
  output: JSON.stringify({
    reports: [
      {
        issue_number: 42,
        conformant: true,
        missing_sections: [],
        forbidden_sections: [],
        empty_sections: [],
        quality_issues: [],
      },
    ],
  }),
});
const result = await runIssueAudit(client, "o", "r", { spawn });

// Plan coverage: the plan-placement LLM returns placements for all issues
// that had no declared phase; create_phase=true means the LLM invented a
// new phase and must supply phase_goal
const placementSpawn = fakeSpawn({
  output: JSON.stringify({
    placements: [
      {
        issue_number: 10,
        phase: "Foundation",
        create_phase: true,
        phase_goal: "Establish the initial delivery scaffolding.",
      },
    ],
  }),
});
const coverage = await runPlanCoverage(client, "o", "r", {
  spawn: placementSpawn,
});
// coverage.llmPlaced === [10], coverage.createdPhases === ["Foundation"]
```

### Layer 2 — Integration tests with recorded fixtures

For tests that exercise multiple modules end-to-end, we replay real agent CLI
responses captured to `tests/fixtures/claude/<task-name>.json` or
`tests/fixtures/codex/<task-name>.jsonl`. Same pattern as
`tests/fixtures/github/`: hand-recorded once, committed to git, reviewed
deliberately when refreshed.

**Why fixtures over hand-written output:** catches drift if the vendor CLI
changes its event or JSON format. Hand-written data is a guess; recorded data
is ground truth from the real tool at the moment of capture.

**Helper:** `packages/core/tests/helpers/replay.ts`

```typescript
import { replaySpawn } from "./helpers/replay.ts";

const spawn = await replaySpawn("issue-audit-conformant");
const result = await runIssueAudit(client, "o", "r", { spawn });
```

`replaySpawn(name)` reads `tests/fixtures/claude/<name>.json` and returns a
spawn function that emits its `output` field. `replayCodexSpawn(name)` reads
`tests/fixtures/codex/<name>.jsonl` and returns a spawn function that replays
the recorded Codex event stream.

**Recording fixtures:** `bun record-claude-fixtures <task> <issue-number>`
runs the real `claude` CLI once with the appropriate prompt, captures the
JSON, and writes it to `tests/fixtures/claude/<task>.json`. Recording requires
real Claude credentials. `bun record-codex-fixtures <name> --prompt "..."` does
the same for Codex JSONL streams. Refresh fixtures only when:

- A prompt builder changes (new fixture name reflects the new prompt)
- Claude's JSON output format changes (rare)
- Codex's event stream format changes
- The task contract changes (e.g., new field added)

### Layer 3 — Live smoke tests behind `SUPERFIELD_LIVE_AGENTS=1`

A handful of tests gated on the `SUPERFIELD_LIVE_AGENTS` env var actually
spawn the real agent CLIs end-to-end. They never run in PR CI; they run
nightly or manually before a release. By default the live smoke suite runs
against all supported backends; set `SUPERFIELD_LIVE_AGENTS=claude` or
`SUPERFIELD_LIVE_AGENTS=codex` to narrow it.

**Helpers:** `packages/core/tests/helpers/live.ts`

```typescript
import { liveDescribe, liveIt } from "./helpers/live.ts";

liveDescribe("runIssueAudit live smoke", () => {
  liveIt("produces parseable JSON for a real issue", async () => {
    const result = await runIssueAudit(client, "o", "r", {});
    expect(result.audited).toBeGreaterThan(0);
  });
});
```

`liveDescribe()` and `liveIt()` call `describe.skip` / `it.skip` when the
env var is unset, so the suite is silent on PR runs and verbose on nightly.
The live suite exercises the same code path as production, just with a real
vendor CLI behind the agent abstraction.

**What it catches:** prompt drift (the model can no longer follow our prompt),
vendor CLI flag changes, contract violations between our expected JSON shape
and the real model's output.

**What it does NOT catch:** anything Layer 1 or 2 already catches. Layer 3 is
the smallest possible safety net for the assumption that each supported
vendor still works the way our prompts assume.

## Directory layout

```
tests/
  fixtures/
    github/                       # MSW fixtures for the GitHub REST API (existing)
    claude/                       # Recorded JSON responses from `claude --output-format json`
      issue-audit-conformant.json          # batch response: { reports: [...] } all conformant
      issue-audit-non-conformant.json      # batch response: { reports: [...] } with non-conformant
      plan-placement-existing-phase.json   # LLM places issues into an existing phase
      plan-placement-new-phase.json        # LLM creates a new phase for uncovered issues
      blueprint-conformance-arch-violation.json
      feature-evaluate-new.json
      feature-evaluate-duplicate.json
      replan-evaluate-fresh.json
      doc-coverage-clean.json
      doc-canonical-sync-significant.json
      doc-consistency-clean.json
      README.md                   # how to record / when to refresh
    codex/                        # Recorded JSONL responses from `codex exec --json`
      test-sample.jsonl
      README.md                   # how to record / when to refresh
packages/
  core/
    tests/
      helpers/
        fake-spawn.ts             # Layer 1: canned AgentResult
        replay.ts                 # Layer 2: load fixture, return spawn fn
        codex-replay.ts           # Layer 2: load Codex JSONL fixture
        live.ts                   # Layer 3: env gating
      unit/                       # Layer 1
      integration/                # Layer 2
      live/                       # Layer 3 (gated)
scripts/
  record-claude-fixtures.ts       # Recorder for Layer 2 fixtures
  record-codex-fixtures.ts        # Recorder for Layer 2 Codex fixtures
```

## Recorded fixture format

Claude fixtures contain the exact JSON that `claude --print --output-format
json` would emit, plus a comment block (as a sibling `.md` file or a
top-level `_metadata` field) describing what input produced it. Codex
fixtures contain the raw `codex exec --json` event stream, usually as JSONL
with a leading `thread.started` event.

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "session_id": "01JNXXXXXXX",
  "result": "{\"issue_number\":42,\"conformant\":true,\"missing_sections\":[],...}",
  "cost_usd": 0.012,
  "duration_ms": 4500,
  "num_turns": 1,
  "_metadata": {
    "captured_at": "2026-04-08T03:00:00Z",
    "prompt_builder": "buildIssueAuditPrompt",
    "input_summary": "well-formed feature issue #42 with all sections present"
  }
}
```

`replaySpawn` ignores the `_metadata` field and returns the fixture verbatim
as the spawn output. The `result` field's stringified JSON is what
`runLLMTask`'s `extractJson` will parse.

## Recording new fixtures

```bash
# Set token with write access (read-only is fine for most tasks)
export GITHUB_TOKEN=ghp_xxx

# Record one fixture from a real issue in the test repo
bun record-claude-fixtures issue-audit dot-matrix-labs/superfield-ts 42 > \
  tests/fixtures/claude/issue-audit-conformant.json

# Or record all standard fixtures at once
bun record-claude-fixtures --all

# Record a Codex fixture for a one-off prompt
bun record-codex-fixtures test-sample --prompt 'Return only {"answer":42}.'
```

Fixtures are committed to git. Refresh them when:

1. A prompt builder changes — record a new fixture with a name that reflects
   the new contract
2. Claude's CLI JSON output changes — refresh all fixtures
3. Codex's event stream changes — refresh the Codex fixtures
4. The task's expected output schema changes — record + update parser

Never edit fixture files by hand. They are ground truth from the real model.

## Running the suites

```bash
# Layer 1 + 2 — what runs in CI
bun run test:unit
bun run test:integration

# Layer 3 — manual / nightly
SUPERFIELD_LIVE_AGENTS=1 bun --bun vitest run packages/*/tests/live
```

## What we explicitly do NOT test

- **Real merges to real branches.** All git operations in tests use the
  worktree manager against MSW fixtures or local temp dirs. We never push
  to real branches in tests.
- **Real PR creation.** The doc loop's `openDocPR` is unit-tested against
  a mocked GitHub client. Layer 3 may exercise it against a sandbox repo
  but never against the production repo.
- **`claude` / `codex` performance / cost.** Layer 3 measures duration and
  cost as side-channel data, but assertions are about correctness, not speed.
