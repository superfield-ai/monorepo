# Testing Framework

The prototype-era TypeScript runtime spawned an agent CLI as a subprocess;
the appliance instead calls the LLM through the `AgentExecutor` trait
(see [`architecture.md`](architecture.md) §AgentExecutor trait). Real
end-to-end tests against a live model — CLI or endpoint — are slow, expensive,
non-deterministic, and require credentials in CI. This document describes the
three-layer test strategy that keeps the codebase well-tested without paying
that price on every commit. The layers below are documented against the
TypeScript harness where they originated; the same strategy applies at the
appliance's executor seam.

## Three layers

| Layer                               | Speed      | Determinism | Cost   | Coverage       | When it runs         |
| ----------------------------------- | ---------- | ----------- | ------ | -------------- | -------------------- |
| 1. Unit + injected fake             | ms         | total       | $0     | Per-function   | Every PR             |
| 2. Integration with replay fixtures | sub-second | total       | $0     | Cross-module   | Every PR             |
| 3. Live smoke against vendor CLI    | minutes    | low         | real $ | Contract drift | Manually pre-release |

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
spawn the real agent CLIs end-to-end. They never run in PR CI; there is no
nightly workflow that runs them, so today they run only manually before a
release. By default the live smoke suite runs
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
env var is unset, so the suite is silent on PR runs and verbose only when the
var is set for a manual pre-release run. The live suite exercises the same code
path as production, just with a real vendor CLI behind the agent abstraction.

This intentional skip is the **sole sanctioned exception** to invariant 1
(loud-skip, never silent-skip) in
[testing-invariants.md](testing-invariants.md): Layer 3 is a safety net that is
**explicitly not counted as coverage** — everything it touches is already
covered for real by Layers 1 and 2 on every PR — so it is allowed to `skip`
rather than fail when `SUPERFIELD_LIVE_AGENTS` is unset.

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
bun record-claude-fixtures issue-audit superfield-ai/superfield-ts 42 > \
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
# TypeScript, Layer 1 + 2 — what runs in CI
bun run test:unit
bun run test:integration

# TypeScript, Layer 3 — manual, pre-release only
SUPERFIELD_LIVE_AGENTS=1 bun --bun vitest run packages/*/tests/live

# Rust crates (crates/*) — executed in CI by the `rust.yml` workspace-tests job
cargo nextest run --workspace --no-tests=fail
```

## Rust crates and executed-coverage enforcement

The three-layer strategy above describes the TypeScript agent-runtime harness.
The Rust crates under `crates/*` (e.g. `crates/fastenv`) are tested separately:
`cargo nextest run --workspace --no-tests=fail` runs in the `rust.yml`
workspace-tests job, and `--no-tests=fail` makes a run that collects zero tests
red rather than a false green.

Both stacks are governed by the repo's executed-coverage invariants — loud-skip
over silent-skip, exit 0 ≠ tested, runtime behaviour needs an executed-in-CI
assertion, and required checks must cover every language present. Those rules,
plus the `coverage-truth.toml` unit-to-test-job mapping and the
`scripts/check-coverage-delta.sh` gate (which enforces >0 executed tests per
touched Rust crate), are documented in
[testing-invariants.md](testing-invariants.md). Read that document before
adding a test you intend to count as coverage.

## Running CI workflows locally with `act`

> **Interim status.** `act` is the local method **only while GitHub Actions
> remains the push target**. The accepted
> [CI-execution-manifest ADR](adr-ci-execution-manifest.md) rules that the
> appliance does not embed a GHA YAML parser or an ACT-style runner emulator:
> the source of truth for CI execution is the fastenv CI manifest, with GHA
> YAML generated as an adapter and validated by
> [`manifest-lint.yml`](../.github/workflows/manifest-lint.yml). Everything in
> this section is workflow-debugging tooling for that interim, not appliance
> architecture — do not build new gating on the emulation path.

Many of our workflows pin a job `container:` to the shared CI image
`ghcr.io/superfield-ai/ci-runner:latest` (e.g.
[`.github/workflows/eval-todo-app.yml`](../.github/workflows/eval-todo-app.yml)).
We run them locally with [`act`](https://github.com/nektos/act) so a local run
executes the **unmodified** workflow YAML in the same container CI uses — no
duplicate, drift-prone local script. The repo-root
[`.actrc`](../.actrc) maps the `self-hosted` / `Linux` / `X64` runner labels to
that image.

### TL;DR — run it locally

```bash
# Runs the UNMODIFIED eval-todo-app.yml end to end against the local ci-runner
# image; downloads a glibc node20 to ~/.cache/superfield/act-node on first use
# and injects it into the job container the way GitHub's runner agent does.
evals/scripts/run-local-act.sh -- --input turn_budget=3

# Any container-job workflow (image untouched, YAML untouched):
WORKFLOW=.github/workflows/<wf>.yml evals/scripts/run-local-act.sh
```

This works on **stock `act` v0.2.89** with the **production `ci-runner` image
unmodified** and the local `:latest` tag never overwritten. The rest of this
section explains why a naive `act` run fails first, and the three ways to fix it.

### How `node` gets into a container job (mechanism)

JavaScript GitHub Actions (`actions/cache`, `actions/upload-artifact`,
`hashFiles`, …) run under a `node` binary. **That binary comes from the runner
agent, not from the image and not from the host:**

- **GitHub (canonical).** The `actions/runner` agent ships its own Node runtimes
  in its install tree (`externals/node20/`, …). When a job declares
  `container:`, the agent starts that container with the externals dir
  bind-mounted **read-only at `/__e`** and invokes JS actions by **absolute
  path**: `/__e/node20/bin/node /__w/_actions/<owner>/<repo>/<ref>/dist/index.js`.
  `node` is _mounted at runtime, never installed in the image_, so any
  glibc-compatible image runs JS actions fine. The only constraint is glibc
  compatibility (the mounted node is glibc-linked); `ci-runner` is debian/glibc,
  so it satisfies it. This is identical on hosted and self-hosted runners,
  because `node` travels with the runner software. **This is why `ci-runner`
  correctly omits `node` — and must keep omitting it.**

- **`act` (by convention).** `act` is not the `actions/runner` agent; it is an
  ordinary host process driving the Docker daemon, and it has **no `/__e`
  externals-mount logic anywhere**. It resolves node by exec'ing bare `node` in
  the job container (`pkg/runner/run_context.go` `startContainer`/`prepareNode`,
  ~`:473-483`: it runs `node --no-warnings -e console.log(process.execPath)` and,
  on failure, falls back to the literal string `"node"`), i.e. a plain `PATH`
  lookup — which is why act's default images (`catthehacker/ubuntu:act-*`) bundle
  `node`. A custom pinned `container:` like `ci-runner` has no `node` on `PATH`,
  so the lookup fails with `exec: "node": executable file not found in $PATH`
  (exit 127). Worse, for a job with a `container:` block, act's
  `RunContext.options()` (`pkg/runner/run_context.go:783`) returns **only** the
  YAML `container.options` and **discards** the CLI `--container-options`, so you
  cannot bind-mount node in that way either. The contracts are inverted: GitHub =
  "node comes from the agent"; act = "node comes from the image". Tracked upstream
  as [nektos/act#107](https://github.com/nektos/act/issues/107).

### Two-environment topology

For a job that pins `container:` there are **two** execution environments, not
three:

- **The host** — where the `act` process and the Docker daemon live. `act` plays
  the runner-agent role here; it has no job environment of its own.
- **The `ci-runner` job container** — where every `run:` step and every JS action
  executes. `node` must be present _inside this container_; GitHub mounts it
  there, `act` does not.

A service like `pgvector` runs as a **sibling** container on the same Docker
network — it is not a nesting layer.

### The `actions/checkout` special-case (and the failure boundary)

`actions/checkout` is itself a JS action but still succeeds under `act` without
`node`: `act` short-circuits it with a `docker cp` / `CopyDir` of the local
working tree (`pkg/runner/step_action_remote.go:167`) instead of running its
node entrypoint. The failure therefore lands not at checkout but at the **first
JS action `act` actually executes via `node`** — `hashFiles` / `actions/cache@v4`
(in `eval-todo-app.yml`, the `Cache Cargo registry + build` step).

### Three ways to provide `node` (all keep the image + `:latest` untouched)

A probe under **act 0.2.89** confirmed the root cause: a throwaway workflow
pinned to `container: ci-runner` with a single `actions/cache@v4` step fails
`exec: "node": not found` (exit 127) both with no mount **and** with
`--container-options "-v <glibc-node>:/usr/local/bin/node:ro"` — a follow-up
`run:` step proved the mount never lands inside the pinned container (matching
`options()` discarding `--container-options` above). Three approaches do work,
each mirroring GitHub's _mechanism_ (provide node at runtime) rather than baking
node into an image:

- **(A) `docker cp` node-injection watcher — the documented default.** Stock act
  v0.2.89 plus a tiny background watcher that, the instant act starts a ci-runner
  job container, `docker cp`s a downloaded glibc node20 onto the container `PATH`
  (`/usr/local/bin/node`) before the first JS action runs. Workflow YAML
  unmodified, production image untouched, `:latest` never overwritten.
  Implemented by [`evals/scripts/run-local-act.sh`](../evals/scripts/run-local-act.sh)
  (it downloads node to a cache dir on first use — node is never vendored into
  the repo). **This is the approach used in the end-to-end run below.**

- **(B) [ChristopherHX/runner.server](https://github.com/ChristopherHX/runner.server)
  `Runner.Client` — max fidelity.** A released binary (no .NET install) that
  faithfully emulates the GitHub Actions runner, including the real `/__e`
  externals bind-mount. Closest to production behaviour. Caveat: it always
  `docker pull`s the pinned image, so it needs a ghcr token with `read:packages`
  (current CI tokens lack it) **or** a local-registry mirror of the
  already-present image. Note it is **not** `act` (a different runner), so the
  `.actrc` UX does not apply.

- **(C) Patched `act` / Gitea's `act` fork — keep the `act` UX.** A one-line
  change to `RunContext.options()` so `--container-options` reaches the pinned
  container (already shipped in [Gitea's act fork](https://gitea.com/gitea/act));
  then you bind-mount node via `.actrc` / the CLI. Verified locally against a
  patched build. Keeps unmodified YAML and the familiar `act` interface, but
  requires running a non-stock `act` binary.

**Ruled out (do not retry):**

- `-P <label>=<image>` / "wrap the job in another runner image (e.g. alpine)" —
  for a job with a `container:` block, the pinned image **always wins**; `-P`
  only maps `runs-on` labels for container-less jobs. (alpine/musl would be wrong
  anyway: ci-runner is glibc, so the injected node must be glibc.)
- `--container-options` bind-mount — discarded for pinned-container jobs (above).
- Toolcache / externals pre-seed via host mounts — same reason; never reaches the
  pinned container.
- Baking node into a **separate** local image tag — can't run the _unmodified_
  workflow (it pins `:latest`) without overwriting `:latest`, which the
  self-hosted runner uses. (A throwaway `ci-runner:act-node` tag exists only as a
  local experiment; it is **not** a recommended path.)

**Never** add `node` to the production `ci-runner` image (shared by ~16
workflows; the design deliberately omits it) and **never** overwrite the local
`:latest` tag.

### Proven end to end

Approach (A) ran the **unmodified** `eval-todo-app.yml` to completion on this
host under stock act v0.2.89: `🏁 Job succeeded` (exit 0), **zero**
`node: not found` errors. Both previously-blocking JS actions passed —
`Cache Cargo registry + build` (`actions/cache@v4`) and
`Upload the eval results tree` (`actions/upload-artifact@v4`) — and the full
pipeline ran (rustup → build → governed embed weights → boot appliance → seed →
keyless live loop → `result.json` → artifact upload). The deterministic rungs
came back green (`seed`/`ingest`/`semantic_search` = `true`) and `result.json` +
`project-graph.md` + `turns.json` + logs were uploaded as the workflow artifact.
`ci-runner:latest` was verified still node-free afterward.

> **Dry-run caveat:** `act -n` cannot preview a workflow with service containers
> — it panics on the `pgvector` service. Use `act -l` to validate parsing, and a
> real run (the helper above) to execute.

## What we explicitly do NOT test

- **Real merges to real branches.** All git operations in tests use the
  worktree manager against MSW fixtures or local temp dirs. We never push
  to real branches in tests.
- **Real PR creation.** The doc loop's `openDocPR` is unit-tested against
  a mocked GitHub client. Layer 3 may exercise it against a sandbox repo
  but never against the production repo.
- **`claude` / `codex` performance / cost.** Layer 3 measures duration and
  cost as side-channel data, but assertions are about correctness, not speed.
