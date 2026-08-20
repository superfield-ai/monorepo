# evals/

Evaluations of the Superfield **AI processes** — the autonomous gardening loop
that turns intent into software. This is the home of our equivalent of an
end-to-end test: the artifacts that confirm a user is getting what they expect
from running the appliance.

> **Specs here, code in `crates/sf-eval`.** This tree holds the scenario data
> and the markdown specs for each runner/grader; the Rust grader library + the
> `sf-eval` live-runner binary that execute them live in
> [`crates/sf-eval`](../crates/sf-eval/) (issue #748). Run outputs land in
> `results/` (gitignored). See [`docs/eval-design.md`](../docs/eval-design.md)
> for the full design and the Tier 0–3 pyramid.

## Three concepts (keep them separate)

| Concept      | Answers                                         | Lives in     | Example                                            |
| ------------ | ----------------------------------------------- | ------------ | -------------------------------------------------- |
| **Scenario** | _What are we testing, and what counts as pass?_ | `scenarios/` | `todo-app` — build a To Do app                     |
| **Runner**   | _How do we execute and measure?_                | `runners/`   | `live` — seed → serve → poll turns → grade         |
| **Grader**   | _How do we check one thing?_                    | `graders/`   | `project-graph` — does the graph describe the app? |

A scenario is **data** (inputs + acceptance bar). A runner is the **engine**
that drives any scenario. A grader is a **reusable check** a scenario's
acceptance bar is composed from. Adding a second scenario is then cheap: a new
`scenarios/<name>/` dir reusing the existing runners and graders unchanged.

## Layout

```
evals/
  README.md                   ← you are here
  scenarios/                  ← the fixtures (data only, one dir per case)
    todo-app/
      README.md               ← the scenario spec
      seed/todo-seed.md       ← intent gardened in at kickstart
      acceptance.md           ← the acceptance bar (rungs) for THIS scenario
      snapshot/               ← (future) frozen brain state to start from
  graders/                    ← reusable checks, referenced by scenarios
    project-graph.md
    compiling-candidate.md
    browser-smoke.md
  runners/                    ← the engines (specs now, code later)
    live.md                   ← Tier 2: live run, counts turns
    replay.md                 ← Tier 1: replay an episode trace
  scripts/
    run-local-act.sh          ← run the unmodified CI workflow locally via act
  results/                    ← run outputs (gitignored)

../.actrc                     ← act runner-label → ci-runner image mappings
../.github/workflows/eval-todo-app.yml  ← the eval workflow (single source of truth)
```

## Running an eval locally

The eval CI workflow has **one source of truth**:
[`.github/workflows/eval-todo-app.yml`](../.github/workflows/eval-todo-app.yml).
We run it locally with [`act`](https://github.com/nektos/act), which executes
that workflow **unmodified, in containers** — so a local run is the same run CI
performs, with no duplicate local script to drift out of sync and no pollution
of your dev environment (toolchain, Postgres, opencode all live in the
container).

Canonical command (run from the repo root):

```
evals/scripts/run-local-act.sh -- --input turn_budget=8
```

[`evals/scripts/run-local-act.sh`](scripts/run-local-act.sh) runs the
**unmodified** workflow under stock `act` and supplies `node` to the pinned
`ci-runner` job container at runtime — the way GitHub's runner agent does —
without modifying the production image or overwriting the local `:latest` tag.
It downloads a glibc node20 to a cache dir on first use (never vendored into the
repo), starts a background node-injection watcher, and invokes `act` with
`--pull=false` and an artifact dir. Arguments after `--` pass straight to `act`.

The repo-root [`.actrc`](../.actrc) supplies the `-P` runner-label mappings
(`self-hosted`, `Linux`, `X64` → `ghcr.io/superfield-ai/ci-runner:latest`)
automatically, so the self-hosted job schedules against the local CI image.

Prereqs:

- **Docker** running.
- The `ghcr.io/superfield-ai/ci-runner:latest` image present locally (so
  `--pull=false` works without ghcr authentication).
- `act` on your `PATH`; `curl` + `tar` (for the one-time node download).

Where the result lands: the job bind-mounts the workspace, so
`result.json` appears on the host at
`evals/results/todo-app/<workspace-id>/result.json` (gitignored). The same file
is also collected by the artifact step into the helper's artifact dir.

### Why the helper (and not bare `act`)?

Bare `act` stops at the first JavaScript action (`Cache Cargo registry + build`,
`actions/cache@v4`) with `exec: "node": not found` (exit `127`). This is **not**
a defect in the `ci-runner` image: `node` for JS actions is supplied by the
_runner agent_ at runtime (GitHub bind-mounts it into the `container:` job at
`/__e`), and `act` does neither that mount nor honour `--container-options` for a
pinned `container:`. The image correctly omits `node`, and the helper restores
the missing runtime injection. The full mechanism, the two-environment topology,
the `actions/checkout` `docker cp` special-case, the three working approaches
(watcher / runner.server / patched-act), and the ruled-out dead ends are
documented canonically in [`docs/testing.md`](../docs/testing.md) → **"Running
CI workflows locally with `act`"**. Upstream gap:
[nektos/act#107](https://github.com/nektos/act/issues/107) (see also
[#810](https://github.com/superfield-ai/monorepo/issues/810)).

> **Caveat:** act's `-n` dry-run can't preview this workflow — it panics on jobs
> with service containers (the `pgvector` Postgres service here). Use `act -l` to
> validate parsing instead, and the helper above for a real run.

## Why scenario-first (not `tier1/`, `tier2/`)

Tiers are a property of the _runner_, not the test material, and one scenario is
exercised by multiple tiers (the same scenario's live trace is later replayed by
Tier-1 graders). Keeping the test material in one place per scenario means you
describe the To Do app once, not once per tier.

## Scenario-directory discovery contract (Tier-2 corpus)

The Tier-2 corpus driver (docs/eval-design.md sequencing item 2, #863,
`sf-eval corpus` — see below) runs **every** scenario under
`evals/scenarios/`, not just `todo-app`. What counts as a discoverable
scenario is a pinned contract, implemented as
[`sf_eval::discover_scenarios`](../crates/sf-eval/src/corpus.rs) — a
directory under `evals/scenarios/` qualifies iff it has:

- a `README.md` at the scenario root (the spec, as above),
- an `acceptance.md` at the scenario root containing a rung table (mirroring
  the `| Rung | ... |` table `todo-app/acceptance.md` uses), and
- a `seed/` subdirectory containing at least one `.md` seed-intent file.

A directory missing any of these fails discovery loudly (naming the scenario
and the missing piece) rather than being silently skipped, so a malformed
scenario directory cannot quietly drop out of the corpus run. This is the
layout the `icp-fidelity` scenario (#865) mirrors so it is enumerable by the
same driver without a special case. A fixture corpus proving both a
discoverable green and red scenario lives at
[`crates/sf-eval/tests/fixtures/corpus/`](../crates/sf-eval/tests/fixtures/corpus/)
for #864's nightly-workflow gate-script development.

## Corpus aggregate `result.json` envelope (Tier-2 corpus)

Layered on top of (never replacing) the per-scenario `result.json` convention
(issue #780), the corpus driver additionally emits one aggregate envelope with
exactly one [`sf_eval::ScenarioVerdict`](../crates/sf-eval/src/corpus.rs) per
enumerated scenario — `green`/`red`, with a `failing_stage` named whenever a
scenario is red — and the harness process exits `0` iff every scenario is
green. See
[`crates/sf-eval/tests/fixtures/corpus/result.green.json`](../crates/sf-eval/tests/fixtures/corpus/result.green.json)
and
[`result.mixed.json`](../crates/sf-eval/tests/fixtures/corpus/result.mixed.json)
for example envelopes.

## Invoking the corpus driver (`sf-eval corpus`)

```
cargo run -p sf-eval --bin sf-eval -- corpus \
  --scenarios-root evals/scenarios \
  --results-root evals/results \
  --endpoint-health-addr 127.0.0.1:4096
```

Enumerates `--scenarios-root` (the discovery contract above), then — for each
discovered scenario, **sequentially**, against the one already-booted
appliance and live model endpoint — seeds the scenario's intent and observes
it through [`sf-eval run`](runners/live.md) (the existing Tier-2 live runner:
deterministic floor, poll-and-grade, emit). "Reset" between scenarios is
implicit: each scenario gets a fresh workspace id, so there is no shared state
to clear. One [`ScenarioVerdict`](../crates/sf-eval/src/corpus.rs) is recorded
per scenario — green, or red naming the failing stage
(`deterministic_floor`, `rungs`, `seed`, `process_error`) — aggregated into
`<results-root>/corpus-result.json`. The process exits `0` iff every scenario
is green; a discovery failure or an empty corpus also fails non-zero (never a
vacuous green for zero scenarios executed).

`--endpoint-health-addr <host:port>` runs a reachability precheck against the
live model endpoint **before** any scenario executes — unreachable fails the
whole corpus loud (every scenario recorded red, `endpoint_unreachable`, no
skip). `--scenario-cmd <path>` overrides the per-scenario execution command
(used by the hermetic tests in
[`crates/sf-eval/tests/corpus_harness.rs`](../crates/sf-eval/tests/corpus_harness.rs)
to exercise the aggregation/exit-code/failing-stage/enumeration/unreachable-
endpoint behaviour without a live model or database — see
[`crates/sf-eval/src/corpus_runner.rs`](../crates/sf-eval/src/corpus_runner.rs)
for the driver).

The nightly workflow that boots the appliance and schedules this invocation on
a cron is a separate feature (docs/eval-design.md:111-116, #864).

## Glossary

- **Turn** — one completed gardening step (the loop has 9 per pass). The headline
  cost metric every runner reports; not specific to any one scenario.
- **Acceptance bar** — the set of graders, with thresholds, that must pass for a
  scenario to count as "the user got what they expected."
- **Rung** — one grader in a scenario's acceptance bar.
