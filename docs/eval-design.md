# Evaluating the Superfield Appliance

This document describes how we evaluate the **AI processes** inside the
Superfield appliance — the autonomous gardening loop that turns intent into
shipped software. It is the design for our equivalent of an end-to-end test:
the artifact that confirms a user is getting what they expect from running the
appliance.

It is a companion to [testing.md](./testing.md). Testing covers deterministic
code (Rust/TypeScript units, replay fixtures, vendor-CLI smoke). This document
covers the part that is _not_ deterministic: whether the loop, driven by a real
model, produces an outcome a user would accept.

## The reframing: evals, not assertions

You cannot end-to-end test an agent loop the way you test deterministic
software. Exact-match assertions fail the moment the model varies its wording,
its plan, or its file layout — all of which can be individually correct. The
equivalent of an e2e test here is a **scenario eval**:

> a frozen starting state + a seed intent + machine-checkable acceptance
> criteria, run through the _real_ loop, scored over N runs to a pass
> threshold.

"The user got what they expected" becomes a concrete proposition:

> the artifact the loop produced satisfies the acceptance criteria the loop
> itself derived and a human ratified.

We already produce most of the substrate for this. Every loop run writes an
**episode trace** (`sharp.episodes` + `sharp.episode_typed_artifacts`: `prompt`,
`context`, `tool_call`, `tool_result`, `validation`, `judge`). That trace is the
eval ledger. The work is largely to _grade_ it, not to build new recording.

## The missing primitive: executable acceptance criteria

Today `AcceptanceCriterion` exists as a node type in `nexum.project_nodes` but
is **unused and non-gating** — there is no acceptance-criteria data attached to
a Feature, and nothing checks it. This is the keystone of the whole design.
This section owns that gap: `docs/milestone-1.md` §4.6 records the
acceptance-criterion and test-linkage items as delivered-as-schema-only /
deferred and points here.

We make each acceptance criterion an _executable behavioral assertion_ attached
to a Feature, one of:

- an **HTTP/probe check** against the deployed preview
  (e.g. "`POST /orders` returns `201` and persists a row"),
- a **Playwright check** against the Studio app preview
  (e.g. "the order form shows a confirmation toast on submit"), or
- a **`RequiredTest`** the generated code must contain and pass.

Once acceptance criteria are executable, "did the user get what they expect" is
a literal boolean per feature. The human's job shifts from reading diffs to
**ratifying and editing the criteria** — steering intent, exactly as the
product thesis intends.

## The eval pyramid

We layer evals by cost, determinism, and how much of the loop they exercise.
This mirrors the structure of [testing.md](./testing.md), applied to the AI
process rather than the code.

| Tier | What it exercises                         | Determinism | Cost   | When it runs                                |
| ---- | ----------------------------------------- | ----------- | ------ | ------------------------------------------- |
| 0    | Loop mechanics via injected fixtures      | total       | $0     | Every PR                                    |
| 1    | A single step's output, replayed & graded | total\*     | ~$0    | Every PR                                    |
| 2    | The whole loop, live, from seed intent    | low         | real $ | Pre-release (manual today; nightly planned) |
| 3    | Production episodes, scored continuously  | n/a         | n/a    | Always (online)                             |

\* Tier 1 replays recorded artifacts, so the _inputs_ are fixed; an LLM-judge
grader is itself sampled and thresholded (see Non-determinism).

### Tier 0 — Deterministic seam tests (have this today)

`FixtureAgentExecutor` (`crates/sf-loop/src/agent.rs`) already lets us test loop
plumbing without a model: stage ordering across the nine gardening steps,
`orchestrator.gardening_cursor` resume-after-crash, and the merge gates
(`cargo_check`, `ast_equivalence`, `tier1` classification). This confirms the
_plumbing_, not the _intelligence_. Runs on every PR.

### Tier 1 — Step / artifact graders (build first; cheapest signal)

Replay a recorded episode and score a _single_ gardening step's output against a
rubric:

- did `ArchitectureProposal` respect the Blueprint rules it was handed?
- did `ProjectGraphDerive` emit a well-formed Issue → Feature → Criterion graph
  (valid edge types, no orphans)?
- did `PrdReconcile` avoid the forbidden moves (status updates, vendor lock-in,
  premature architecture)?

Each grader is a structural check, an LLM-as-judge, or both. Because they replay
from `sharp.episode_typed_artifacts`, they are cheap and need no live model.
This is our **regression net** — the fastest way to catch prompt/harness drift.

### Tier 2 — Full scenario evals (the real e2e equivalent)

Seed a **sandboxed Forge** with a frozen brain snapshot plus one seed intent,
run the _entire_ loop against a live model, then assert the outcome:

1. the app **compiles** (the `cargo_check` gate already enforces this),
2. it **deploys** to the PoC host,
3. its behaviors **satisfy the Feature's acceptance criteria**, and
4. **process invariants held** — merges stayed clean, the trace contains no
   hallucinated tool calls, and the loop converged within a cost / iteration
   budget.

Pass = (outcome criteria met) **AND** (process invariants held). This is
expensive and stochastic, so it cannot run per-PR. **Plan of record
(2026-07-02):** Tier 2 runs nightly against the shipped default model, pinned
(`claude-haiku-4-5-20251001` — the `SF_LLM_MODEL` default in
`docs/architecture.md`'s `LoopConfig` table),
gated like the existing `SUPERFIELD_LIVE_AGENTS=1` live-smoke pattern.

The nightly run is
[`.github/workflows/eval-tier2-nightly.yml`](../.github/workflows/eval-tier2-nightly.yml)
(issue #864): a `schedule:` cron plus a manually-dispatchable `budget`
(`minimal` / `standard`) preset, `CI_CLASS: heavy` (no `pull_request` trigger —
mirrors `eval-todo-app.yml`), driving the live pinned shipped default model
under an enforced turn-count (`TURN_BUDGET`) **and** wall-clock
(`SF_EVAL_DEADLINE_SECS`) budget cap. Every run uploads the corpus `result.json`
and the per-scenario logs as retained artifacts under the `evals/results/**`
prefix (30-day retention). `scripts/eval-tier2-nightly-gate.sh` reds the run
out — never a silent skip, never a fake green — when any scenario is red, when
zero scenarios executed, when the budget cap is breached, or when the
`SF_LLM_API_KEY` live-model credential is missing; until an operator
provisions that repo secret, every nightly run reds out on the missing-secret
condition rather than silently reporting green.

`scripts/eval-tier2-nightly-dispatch-smoke.sh` is the scripted check for that
workflow's end-to-end shape: it asserts a run **reached the gate step** (the
step executed — not `skipped`, not absent) and **retained both artifacts**
(`eval-tier2-nightly-result-json-<run>` and
`eval-tier2-nightly-scenario-logs-<run>`, at the configured 30-day retention).
A red run still satisfies the smoke check — until `SF_LLM_API_KEY` is
provisioned a red gate is the _expected_ outcome, and what the check pins is
that the pipeline did not silently skip. GitHub only exposes a
`workflow_dispatch` trigger for a workflow file already on the **default
branch**, so the live dispatch can only run post-merge; the asserter's logic is
therefore exercised in CI offline against recorded GitHub REST payloads
(`tests/fixtures/eval-tier2-nightly-dispatch/`) via
`tests/eval-tier2-nightly-gate-selftest.sh`, and the same `assert_run` code
path runs against the live API post-merge.

### Tier 3 — Online eval on production traces

Every live episode is already recorded. We continuously score them with the
Tier-1 graders and track **success rate by `model` × `harness_version`** — a
query the episode docs already anticipate. This is the regression alarm for the
real fleet and the data source for the Studio "trust dashboard."

One trust-dashboard metric is called out by name: the **Forge self-fix
metric** (red-team review R-12) — the tracked form of "the Forge fixed X
defects in itself autonomously, N% approved." It is counted from
`sharp.episodes` / `forge.validation_runs`: a defect signal originating in the
brain → an agent-proposed fix → merged under policy, split by approval mode
(**autonomous** vs **approved**). Two riders, stated as policy rather than as
current fact: a currently-live defect must be designated the metric's standing
acceptance test and frozen against manual fixes (none is designated yet); and
because fresh appliances ship fail-closed, the autonomous count is
definitionally zero until the trust escalator grants a change-class — until
then, vendor dogfood evidence counts, labeled **vendor-approved**.

## Handling non-determinism

The hard part. Our defenses:

- **Pin everything in the fixture:** brain snapshot, model id, harness / prompt
  version, temperature — and record them in the episode (they are already
  columns / artifacts), so any run is reproducible and attributable.
- **Record / replay cassettes** for CI (mirror `tests/fixtures/claude/*.json`);
  reserve **live** runs for the Tier-2 cadence (manual pre-release today,
  nightly planned).
- **Score statistically:** run each scenario _k_ times, require pass-rate ≥ a
  threshold, and use multi-sample judges rather than a single verdict. Track the
  _distribution_, not one lucky run.
- **Separate outcome from process metrics** so a regression tells you _where_ it
  broke:
  - **Outcome:** acceptance criteria satisfied, app deploys.
  - **Process:** clean-merge rate, iterations-to-converge, cost per scenario,
    trace integrity (no hallucinated tools).

## Where it lives

The [`evals/`](../evals/) tree (data + specs) plus the
[`crates/sf-eval`](../crates/sf-eval/) crate — the Rust grader library + the
`sf-eval` live-runner binary (issue #748). The tree separates three concepts —
**scenarios** (data), **runners** (engines), **graders** (reusable checks) — so
adding a scenario is a new dir, not new plumbing:

```
evals/
  README.md                 ← the pyramid, layout, glossary
  scenarios/<name>/         ← inputs + acceptance bar (data only)
    seed/  acceptance.md  snapshot/
  graders/                  ← reusable checks (project-graph, compiling-candidate, browser-smoke)
  runners/                  ← live (Tier 2) + replay (Tier 1) engines
  results/                  ← run outputs (gitignored)
```

See [`evals/README.md`](../evals/README.md) for the full layout and rationale
(scenario-first, not tier-first). Wiring: Tier 0/1 into PR CI; Tier 2 manual
pre-release today, nightly once the planned workflow lands; Tier 3 as a Studio
panel reading the `sharp.episodes` table.

## First scenario: `todo-app`

The minimal starting point — specified in
[`evals/scenarios/todo-app/`](../evals/scenarios/todo-app/) and run by the
`sf-eval` binary — is a single scenario, driven by the
[`live` runner](../evals/runners/live.md), that exercises the real CLI and
browser end to end and answers one question: **how many turns does it take the
appliance to reach an acceptable To Do app?** CI exercises it in
[`.github/workflows/eval-todo-app.yml`](../.github/workflows/eval-todo-app.yml),
which drives the loop **keylessly** with OpenCode's free Big Pickle model
(GLM-4.6): `SF_LLM_PROVIDER=opencode-server` points the loop at a local
`opencode serve` (its `POST /session` + `/session/{id}/message` API), which on a
fresh install reaches the free model with **no API key and no login** — so the
run needs no Anthropic key and no repo secret. It uploads `result.json`.

- **Kickstart:** `superfield garden seed/todo-seed.md` seeds a one-paragraph
  intent (add / list / complete a task), then `superfield serve` boots the loop.
- **Turn = one completed gardening step**, counted by polling
  `orchestrator.gardening_cursor` (corroborated by `nexum.page_revisions`).
- **Acceptance, scoped to today's capability** (see
  [`acceptance.md`](../evals/scenarios/todo-app/acceptance.md)): rung 1 — the
  project graph describes add/list/complete; rung 2 — a `CodeChangeProposal`
  produced a _compiling_ candidate (`merge_result` recorded). A Playwright smoke
  confirms Studio renders the plan + issue rail, with a marked hook to drive a
  real generated app once deploy lands.
- **Output:** `result.json` with `turns_to_acceptable` and per-rung pass/fail.

It is intentionally rough (poll-based turn counting, keyword-or-judge rung 1) —
a substrate for experimentation, not a gate. Mind the model gap: the keyless CI
run exercises the loop's plumbing on a free third-party model, not the shipped
default, so its green badge is not quality evidence for the model customers
run. Quality evidence comes from the Tier-2 plan of record — runs on the
pinned shipped default model (`claude-haiku-4-5-20251001`). As the loop gains auto-commit →
build → deploy, the browser leg upgrades from a render smoke to the true
behavioral acceptance check, and this scenario becomes the template for more.

The next Tier-2 scenario on the roadmap is **ICP fidelity**: a
non-engineer-authored seed intent, run with the fail-closed install policy
active and outcome-level approval exercised end to end — the evidence that
backs the PRD's time-to-first-app metric.

## Sequencing

1. **Executable acceptance criteria** — data model + gating change. Forces "what
   does the user expect" to become data and unblocks every higher tier.
2. **A 3-scenario Tier-2 harness** — exercises the whole loop honestly and gives
   one green/red signal per release.
3. **Tier-1 graders** — the cheap regression net, run on every PR.
4. **Tier-3 dashboard** — continuous online scoring of the live fleet.

Acceptance criteria + a small Tier-2 harness are the first move: they make the
user's expectation checkable and prove the entire loop end to end. Sequencing
is binding in one direction (plan of record, 2026-07-02): executable acceptance
criteria land **before** any outcome guarantee is claimed — until step 1
ships, no document or badge may assert that user outcomes are verified.

The same binding pattern extends to three adjacent claims (open-tensions
review, 2026-07-03). No document may claim a continuously current
whole-company view until freshness metadata ships on external reads (P-1).
No document may claim usage-derived specs below the signal floor until that
floor is defined and enforced (P-3). No document may claim autonomous
self-repair until the Tier-3 self-fix metric above records it (P-4).

## Component reference

| Concept               | Where                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Gardening loop        | `crates/sf-loop/src/lib.rs` (`GardeningLoop`)                                                                                         |
| Agent executor seam   | `crates/sf-loop/src/agent.rs` (`LlmAgentExecutor` / `Fixture…`)                                                                       |
| LLM provider wire     | `crates/sf-loop/src/provider.rs` (`LlmProvider`; `SF_LLM_PROVIDER`)                                                                   |
| Eval runner + graders | `crates/sf-eval` (`sf-eval run`, `evaluate_run`, graders)                                                                             |
| Episode trace         | `sharp.episodes`, `sharp.episode_typed_artifacts`                                                                                     |
| Merge gates           | `crates/sharp/src/{cargo_check,ast_equivalence,tier1}.rs`                                                                             |
| Project graph / nodes | `nexum.project_nodes` (incl. unused `AcceptanceCriterion`)                                                                            |
| Resume cursor         | `orchestrator.gardening_cursor`                                                                                                       |
| User surface          | Studio `/studio/*`, `WS /studio/ws`                                                                                                   |
| Tier-2 scenarios      | `evals/scenarios/{todo-app,icp-fidelity}` (loop-plumbing fidelity vs. non-engineer-seed install-policy/approval fidelity, issue #865) |
| Policy engine         | `crates/sf-db/src/policy.rs` (`Policy::evaluate`, `MergeDecision`, fail-closed when no policy is active)                              |
| Change lifecycle      | `crates/sf-db/src/change.rs` (`ChangeState`, `awaiting-approval → merged`)                                                            |
