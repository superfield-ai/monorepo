# Agent Ensure-Feature Registry

Registry of shipped product capabilities and the shell commands that prove they
still work. Run the relevant verify commands before opening any PR. Never delete
entries.

---

## Daemon starts the gardening loop + supervises appliance workloads (issue #671)

On daemon boot the appliance starts the real gardening loop (installs the real
`GardeningLoopHandle`, retiring `NoopLoopHandle` on the running path), brings its
own app + Postgres workloads up under the real `FastenvSupervisor`, and on
SIGTERM drains the loop → takes the appliance down → stops the Postgres
provisioner in that strict order. The loop resumes from its persisted
`orchestrator.gardening_cursor` on restart.

Key files:

- `crates/superfield/src/daemon_runtime.rs` — boot + ordered shutdown
  (`boot_loop`, `boot_supervisor`, `appliance_manifest`, `build_executor`,
  `shutdown`).
- `crates/superfield/src/main.rs` `run_as_daemon` — wires the above and uses
  `serve_with_shutdown` + a SIGTERM/SIGINT signal.
- `crates/sf-serve/src/lib.rs` `serve_with_shutdown` — graceful-shutdown serve.

Verify (no DB required — unit suite asserts drain→down→stop ordering, abort
fallback, manifest shape, and real-supervisor health tracking):

```bash
cargo test -p superfield --test daemon_loop_integration
cargo clippy --workspace --all-targets -- -D warnings
```

Verify with a database (DB-gated `#[ignore]` tests — boot records a tick,
shutdown drains before provisioner stop, cursor resume continues past the last
committed step). Requires Postgres with `public.workspaces`,
`nexum.page_revisions`, and `orchestrator.gardening_cursor` applied:

```bash
DATABASE_URL=postgres://… cargo test -p superfield --test daemon_loop_integration \
  -- --ignored --test-threads=1
```

---

## Brain knowledge → Feature/Issue project-graph nodes, with create/list API + CLI (issue #672)

Step ④: knowledge becomes actionable work. A 7th gardening step
(`GardeningStep::ProjectGraphDerive`, last in `STEP_ORDER`) reads the brain's
`plan`/`prd`/`strategy` pages, asks the executor for a line-oriented
`ISSUE:`/`FEATURE:` derivation, and writes the parsed nodes via
`sf_db::insert_issue`/`insert_feature` (project graph — NOT page revisions).
Humans reach the same surface via HTTP (`POST/GET /studio/issues`,
`POST /studio/issues/update`, `POST /studio/steer`) and CLI
(`issue create|list`, `feature create|list`). Created nodes read back through
`GET /pages/project` (`sf_db::fetch_project_page`) and `superfield page project`.

Key files:

- `crates/sf-db/src/project_graph.rs` — `update_node` (state/title; backs
  update + steer), `list_nodes`, `NODE_STATES`, `ProjectGraphError::InvalidState`.
- `crates/sf-loop/src/steps/project_graph_derive.rs` — the derive step +
  `parse_derivation`.
- `crates/sf-serve/src/routes/studio.rs` — `create_issue`, `list_issues`,
  `update_issue`, `steer` (all use `acquire_workspace` for RLS).
- `crates/sf-cli/src/project.rs` + `lib.rs` — `issue`/`feature` verbs.

Verify (no DB — pure parse + router-wiring + CLI-parse unit tests):

```bash
cargo test -p sf-db -p sf-loop -p sf-cli -p sf-serve
cargo clippy --workspace --all-targets -- -D warnings
```

Verify with a database (DB-gated `#[ignore]` tests — derive writes nodes that
appear in the project page; CLI create→list round-trip). Requires Postgres with
the nexum project-graph migration (`0002_project_graph.sql`) applied:

```bash
DATABASE_URL=postgres://… cargo test -p sf-loop -p sf-db -p sf-cli \
  -- --ignored --test-threads=1
```

---

## Live cluster-status SSE preview stream + v0-init acceptance gate (issue #675)

`GET /studio/cluster/events` (auth-protected, `crates/sf-serve/src/routes/cluster.rs`)
streams cluster-status transitions as named `cluster-status` SSE events
(`{status, workspace_id}`); the first event is the current-state snapshot so late
subscribers are not stuck at `unknown`. The control-panel `IframePanel` keys its
preview reload off the `restarting → healthy` transition. The stream is driven by
`OrchestratorState::set_cluster_status` (de-dupes; broadcasts only on a real
transition) in `crates/sf-serve/src/orchestrator_state.rs`. The daemon seeds it
at boot from the real appliance `app` workload health via
`daemon_runtime::seed_cluster_status` / `cluster_status_from_health`. The e2e
acceptance gate (`crates/sf-serve/tests/e2e_journey.rs`) fills the five
JourneySteps with offline-verifiable assertions (deploy/health, preview stream
restart-to-healthy, ingest route, project projection, queue endpoints).

Key files:

- `crates/sf-serve/src/routes/cluster.rs` — `events` SSE handler + `router`.
- `crates/sf-serve/src/orchestrator_state.rs` — `ClusterStatus`,
  `set_cluster_status`/`subscribe_cluster`/`cluster_status`.
- `crates/superfield/src/daemon_runtime.rs` — `seed_cluster_status`,
  `cluster_status_from_health`, `PREVIEW_WORKLOAD`.
- `crates/sf-serve/tests/e2e_journey.rs` — the v0 acceptance gate.
- `packages/control/apps/src/controllers/ClusterStatusController.ts` +
  `components/IframePanel.tsx` — the UI consumer (already wired).

Verify (no DB — SSE/router-wiring + mapping + e2e-gate unit tests):

```bash
cargo test -p sf-serve -p superfield
cargo clippy -p sf-serve -p superfield --all-targets -- -D warnings
```

---

## Runtime-signal feeder: production signals projected into the brain (issue #708)

A deployed app's errors and health signals are recorded by the producer
(`sharp::runtime_signal::record`) to `sharp.runtime_signals` and projected by
the feeder (`nexum::runtime_signal_projection::project_runtime_signal`) into
`nexum.entities`/`nexum.relations`: a `runtime_signal` entity joined to a
`deployment` entity via an `observed_on` relation, all scoped to the signal's
`workspace_id`. Signals now carry `workspace_id` (sharp migration
`0008_sharp_runtime_signal_workspace.sql`; threaded through `record`,
`RuntimeSignal`, and the queries) so a cross-workspace read cannot surface
another tenant's signals. The deployment node is reused across signals. The TS
`RuntimeSignalSource` is no longer `implemented:false`; the exported
`RUNTIME_SIGNAL_SOURCE` descriptor names the producer + feeder.

Key files:

- `crates/sharp/src/runtime_signal.rs` — `record` (now takes `workspace_id`),
  `RuntimeSignal.workspace_id`, queries select `workspace_id`.
- `crates/sharp/migrations/0008_sharp_runtime_signal_workspace.sql` — adds
  `workspace_id UUID NOT NULL` + FK to `public.workspaces`.
- `crates/nexum/src/runtime_signal_projection.rs` — `project_runtime_signal`,
  `SIGNAL_ENTITY_TYPE`/`DEPLOYMENT_ENTITY_TYPE`/`OBSERVED_ON_RELATION`.
- `packages/core/commands/deploy.ts` — `RUNTIME_SIGNAL_SOURCE`
  (`implemented: true`).

Verify (no DB — unit tests + CI gates):

```bash
cargo test -p sharp -p nexum --lib
cargo clippy -p sharp -p nexum --all-targets -- -D warnings
bun --bun vitest run packages/core/tests/unit/deploy-command.test.ts
```

Verify with a database (DB-gated `#[ignore]` tests — signal becomes a nexum
entity joinable to its deployment id; cross-workspace read does not surface it).
Requires Postgres with the sharp + nexum migrations (incl. 0008 and sf-db
`0003_workspace_id_threading.sql`) applied:

```bash
DATABASE_URL=postgres://… cargo test -p sharp -- --ignored --test-threads=1 \
  signal_projects_to_entity_joinable_to_deployment \
  runtime_error_is_recorded_as_episode_signal_linked_to_deployment
```

The nexum embedder is **not** verified by hand. Its DB-gated `#[ignore]`
coverage runs in CI as the required job
**`nexum embedder coverage (pgvector + governed weights)`**
(`.github/workflows/embedder-coverage.yml`), which executes
`cargo test -p nexum --test integration -- --include-ignored --test-threads=1`
plus the `embed.rs` governed-dimension tests
(`cargo test -p nexum --lib embed::tests:: -- --include-ignored --test-threads=1`).
Trust that job — do not re-introduce a manual local embedder verify (a bare
`--ignored` nexum run); the CI job runs the ignored tests for you.

---

## RLS workspace-isolation applied on the appliance boot path (issue #710)

The appliance daemon's in-process migration runner (`crates/sf-db/src/migrate.rs`,
COMPONENT_DIRS order `sf-db → sf-auth → nexum → sharp`) now applies the
workspace-isolation RLS policies via `crates/sharp/migrations/0009_rls_workspace_isolation.sql`
(mirrored into the LAST component dir so it runs after every schema exists). It
creates a BYPASSRLS `superfield_admin` role, self-ensures the `workspace_id`
column, and ENABLE+FORCE RLS with four CRUD policies keyed on `app.workspace_id`
(fail-closed when unset). `sf_db::acquire_with_workspace_id` sets both
`app.workspace_id` and the legacy `app.current_principal_id`.

Proof: `crates/sf-db/tests/rls_workspace_isolation_integration.rs` — cross-workspace
SELECT/INSERT denial, idempotent `schema_migrations` recording, and a no-RLS
negative control. DB-gated: skips when Postgres server binaries are absent.

Verify (needs `/usr/lib/postgresql/<major>/bin/initdb` present):

```bash
cargo test -p sf-db --test rls_workspace_isolation_integration -- --test-threads=1
cargo fmt -p sf-db -- --check
cargo clippy -p sf-db --tests
```

---

## Seven-role model + route-level authorization (#711)

`sf_auth::Role` is the full seven-role PRD §3 model: `Owner`, `Requestor`,
`Steerer`, `Collaborator`, `Agent`, `Auditor`, `Viewer` (snake_case wire form).
`sf_auth::ALL_ROLES` is the canonical array; `Role::can_write()` is `false` only
for `Auditor`/`Viewer`; `Role::is_owner()` is `true` only for `Owner`.
`session::parse_role` accepts all seven plus the legacy `admin`→`Owner` and
`member`→`Collaborator` aliases (the `auth.sessions.role` CHECK constraint —
widened by `0002_role_model.sql` — accepts all nine).

Route-level authorization lives in `crates/sf-serve/src/authz.rs`: the
`require_write` axum middleware returns `403` when `!role.can_write()`; the
`require_owner` middleware returns `403` when `!role.is_owner()`. Both inspect
the `AuthContext` injected by `auth_middleware` and MUST be layered after it.
Gated routes today: `POST /studio/issues/update` and `POST /studio/steer`
(`require_write`); `POST /orchestrator/start` and `POST /orchestrator/stop`
(`require_owner`). To gate a new route, add
`.layer(middleware::from_fn(require_write|require_owner))` to its MethodRouter
inside the owning route module.

Key files:

- `crates/sf-auth/src/context.rs` — `Role` enum, `ALL_ROLES`, `can_write`,
  `is_owner`.
- `crates/sf-auth/src/session.rs` — `parse_role` (canonical + legacy).
- `crates/sf-auth/src/migrations/0002_role_model.sql` — widened CHECK.
- `crates/sf-serve/src/authz.rs` — `require_write` / `require_owner` gates.
- `crates/sf-serve/src/routes/studio.rs`, `routes/orchestrator.rs` — gated
  routes.

Verify (no DB — gate logic + role-model unit tests; DB e2e tests are `#[ignore]`):

```bash
cargo test -p sf-auth -p sf-serve
cargo clippy -p sf-auth -p sf-serve --all-targets -- -D warnings
```

---

## Outbound notification channel for approvals and high-severity signals (issue #717)

PRD §7: a human is alerted when a change enters `awaiting-approval` or a
high-severity runtime signal fires. The `sf-notify` crate provides the seam:
`NotificationChannel` (Send+Sync transport trait) with a real `WebhookChannel`
and a test `InMemoryChannel`; `Notifier` exposes `notify_awaiting_approval`
(always dispatches) and `notify_signal` (dispatches iff `SignalSeverity::is_high`
— High/Critical; Low/Medium suppressed). Severity is a notification-layer
concept (NOT a column on `sharp.runtime_signals`) so the channel stays decoupled
from the signal store and the policy engine (#716) — the policy decides WHEN,
this crate SENDS.

Verify (no DB — pure unit + doc tests; matches CI gates):

```bash
cargo test -p sf-notify
cargo clippy -p sf-notify --all-targets -- -D warnings
cargo fmt -p sf-notify -- --check
```

---

## Read-only systems-of-record connector seam (issue #718)

The `sf-connector` crate is the read-only seam through which a Superfield app
reads data from an external system of record (PRD US18/§7) without modifying or
replacing it. `Connector` exposes only read verbs (`source_name`, `resources`,
`query`, `fetch` — all `&self`); there is no `insert`/`update`/`delete`/`write`/
`sync` method, and the `assert_read_only` marker plus the
`connector_trait_exposes_only_read_methods` test fail compilation/`cargo test`
if a write-shaped method is ever added. `ConnectorCredentials` are scoped to one
`workspaces.id`; a credential for workspace A cannot bind to a connector for
workspace B. The reference `InMemoryConnector` reads from an immutable
`FakeSource` and never mutates it.

Verify (no DB — pure-Rust unit/integration tests + CI gates):

```bash
cargo test -p sf-connector
cargo clippy -p sf-connector --all-targets -- -D warnings
cargo fmt -p sf-connector -- --check
```

---

## Orchestrator analytics producers: work-slots, cost, plan/doc lanes, check-runs (#712)

The gardening loop drives the orchestrator's observable surface. Running with an
observer (`GardeningLoop::start_observed(.., Some(OrchestratorState))`), per
step the loop:

- publishes a real `WorkSlot` (`OrchestratorState::set_slots`) carrying an
  accumulating `costUsd` so `/analytics/slots` is non-empty with live cost;
- records a per-lane tick via `OrchestratorState::record_tick(Lane, ms)` where
  `GardeningStep::lane()` maps steps → `plan`/`dev`/`doc`, so `/analytics/loops`
  reports live health on ALL three lanes (not only `dev`);
- emits a check-run event via `publish_ci_event` so
  `/analytics/check-runs/stream` has a real producer.

Cost source is the `AgentExecutor`: `AgentResponse::cost_usd` —
`LlmAgentExecutor` derives it from the model's `usage` tokens
(`cost_from_usage`); `FixtureAgentExecutor` returns a fixed non-zero cost. Each
step returns a `StepOutcome { cost_usd }` from `run_step`. `WorkSlot`/`SlotInfo`
carry a `costUsd` field (Rust + TS).

Key files:

- `crates/sf-loop/src/agent.rs` — `AgentResponse::cost_usd`, `cost_from_usage`,
  fixture `FIXTURE_COST_USD`.
- `crates/sf-loop/src/steps/mod.rs` — `StepOutcome`, `LoopLane`,
  `GardeningStep::lane()`; all step `run`s return `StepOutcome`.
- `crates/sf-loop/src/lib.rs` — `run_loop` publishes slots/cost, records
  per-lane ticks, emits CI events (`lane_to_serve`/`lane_label`).
- `crates/sf-serve/src/orchestrator_state.rs` — `Lane`, `record_tick`/
  `record_failure`, `WorkSlot.cost_usd`.
- `crates/superfield/tests/daemon_loop_integration.rs` —
  `loop_publishes_cost_slots_lanes_and_ci_events` (DB-gated, `#[ignore]`).
- `packages/core/api-state.ts` + `OrchestratorController.ts` — `SlotInfo.costUsd`.

Verify (no DB — route/state unit tests cover the API contract; the loop-driven
assertion is the DB-gated `#[ignore]` integration test):

```bash
cargo test -p sf-serve -p sf-loop -p superfield
cargo clippy -p sf-serve -p sf-loop -p superfield --all-targets -- -D warnings
```

## Eval harness: live runner, openai-compatible provider, todo-app CI (issue #748)

The appliance has an evaluation harness for the autonomous gardening loop. The
loop's LLM call selects a wire provider via `SF_LLM_PROVIDER`: `anthropic`
(default; `x-api-key`, top-level `system`, `content[0].text`) or
`openai-compatible` (`Authorization: Bearer`, system-role message,
`choices[0].message.content`), defaulting to OpenCode's free Big Pickle (GLM-4.6)
endpoint/model and `OPENCODE_ZEN_API_KEY`. `crates/sf-eval` is the Tier-2 live
runner: pure turn counting from a `gardening_cursor` sequence, project-graph +
compiling-candidate graders, and `result.json` emission with `turns_to_acceptable`

- per-rung pass/fail. `.github/workflows/eval-todo-app.yml` (heavy class:
  schedule + dispatch, no PR gate) runs the todo-app scenario against Big Pickle
  via Zen and uploads `result.json`.

Files:

- `crates/sf-loop/src/provider.rs` — `LlmProvider` (pure wire shaping).
- `crates/sf-loop/src/agent.rs` / `lib.rs` — `LlmAgentExecutor::with_provider`,
  `LoopConfig.llm_provider`, provider-aware `from_env` defaults.
- `crates/sf-serve/src/agent.rs` — `StudioProvider` mirror (no dep cycle).
- `crates/sf-eval/{runner,graders,result}.rs` + `src/main.rs` (`sf-eval run`).
- `.github/workflows/eval-todo-app.yml`.
- `docs/runtime-agent-selection.md` — model is `opencode/big-pickle`, NOT
  the retired `opencode/minimax-m2.5-free`.

Verify:

```bash
cargo test -p sf-loop -- openai_compatible_request_uses_bearer_auth_and_parses_choices provider_defaults_to_anthropic
cargo test -p sf-eval -- live_runner_emits_result_json_with_turns
cargo clippy -p sf-loop -p sf-serve -p sf-eval --all-targets -- -D warnings
test -f .github/workflows/eval-todo-app.yml
~/.agents/scripts/auto/ci-taxonomy-lint.sh .github/workflows/eval-todo-app.yml
```

## Per-object hash-algorithm `algo` column on `sharp.objects` (issue #725)

`sharp.objects` carries an `algo TEXT NOT NULL DEFAULT 'sha1'` column constrained
to `('sha1','sha256')` (whitepaper §4.0/§4.1), so a single repo can hold both
SHA-1 and SHA-256 objects during Git's hash transition. Added as the NEW additive
migration `0010_sharp_objects_algo.sql` (NOT an edit to the deployed 0001 — the
runner only applies pending files). The migration backfills existing rows to
`'sha256'` because every current writer emits a SHA-256 id. Both writers
(`object::store`, `object::store_canonical` in `crates/sharp/src/object.rs`) tag
their INSERTs `'sha256'` via the `ALGO_SHA256` const; readers/FK tables are
unchanged. Repo-level `objectformat` selection (letting writers emit `'sha1'`) is
a separate, out-of-scope feature.

Key files:

- `crates/sharp/migrations/0010_sharp_objects_algo.sql` — additive column +
  backfill + `objects_algo_check` CHECK + `(algo, sha256)` index.
- `crates/sharp/src/object.rs` — `ALGO_SHA256` const; `algo` bound in both
  `store` and `store_canonical` INSERTs.
- `crates/sharp/tests/integration.rs` — `objects_algo_column` (round-trip,
  default, mixed-repo coexistence) and `objects_algo_check_constraint` (invalid
  algo rejected), DB-gated `#[ignore]`, applying 0001+0010 via
  `apply_objects_algo_migration`.

Verify (no DB in CI — the algo tests are DB-gated `#[ignore]`; CI gates are build

- clippy + fmt):

```bash
cargo build -p sharp --all-targets
cargo clippy -p sharp --all-targets -- -D warnings
cargo fmt -p sharp --check
cargo test -p sharp
```
