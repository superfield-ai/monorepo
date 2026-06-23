# Agent Warnings

Nag list for recurring agent mistakes, settled decisions, and retired API
surfaces. Read before planning or writing any code. Never delete entries.

---

## `GardeningLoopHandle::drain()` is idempotent — a second drain returns `Ok`, not `Err`

`crates/sf-loop/src/handle.rs`: `drain()` takes the done receiver out of its
mutex on the first call; a second `drain()` finds `None` and returns `Ok(())`
(see the `drain_idempotent` unit test). Do NOT assert `drain().await.is_err()`
to prove the loop already stopped — prove ordering/stoppage another way (e.g.
the committed cursor row, or the deterministic order-log unit test in
`crates/superfield/src/daemon_runtime.rs`).

## `nexum.page_revisions.workspace_id` has an FK to `public.workspaces(id)`

Any test that drives the gardening loop / a step (which calls
`sf_db::insert_page_revision`) must first seed a `public.workspaces` row for the
workspace UUID, or the insert fails the FK, the step errors, the loop retries
and never commits its cursor — making cursor-wait assertions hang/fail. See
`seed_workspace` in `crates/superfield/tests/daemon_loop_integration.rs`.

## `superfield` is a binary crate with no lib target

`crates/superfield` only has a `[[bin]]`. Integration tests that need to call
internal modules (e.g. `daemon_runtime`) re-include the source via
`#[path = "../src/<mod>.rs"] mod <mod>;`. When doing this, every `pub fn` in the
module must be exercised (by the re-included `#[cfg(test)]` submodule or the
integration tests) or clippy `-D warnings` fails on dead_code in the test binary.

## Rust CI gates: build all-targets, clippy -D warnings, fmt --check (no `cargo test`)

`.github/workflows/rust.yml` runs `cargo build --workspace --all-targets`,
`cargo run --bin superfield -- noop`, `cargo clippy --workspace --all-targets --
-D warnings`, and `cargo fmt --all --check`. There is no `cargo test` step and no
DB provisioning, so DB-gated integration tests must be `#[ignore]`d (matching the
`sf-loop` cursor tests) and the suite must pass clippy + fmt.

## `STEP_ORDER` has SEVEN gardening steps, not six (issue #672)

`crates/sf-loop/src/steps/mod.rs`: issue #672 added
`GardeningStep::ProjectGraphDerive` as the 7th step (last in `STEP_ORDER`). The derive step writes the **project graph**
(`insert_issue`/`insert_feature`), not page revisions — so it does NOT touch
`nexum.page_revisions` and a DB integration test for it needs the
`0002_project_graph.sql` nexum migration applied, not the page-revision schema.

**SUPERSEDED by #709 + #706:** `STEP_ORDER` now has NINE steps.
`GardeningStep::IntentSpecInference` (#709) was inserted at index 5 (after
`PlanProposal`, before `HolisticReconcile`), and `GardeningStep::CodeChangeProposal`
(#706/#722) is now the 9th/last step. Any test/doc that hard-codes the count must
say 9 (see `step_order_has_nine_entries`; the last-step assertion is
`code_change_proposal_runs_last`). `IntentSpecInference` reads
`sharp.runtime_signals` via `sf_db::fetch_recent_runtime_signals` and, when
signals exist, writes a `spec-delta-proposal` page revision (a PROPOSAL, never
auto-applied); with no signals it no-ops (writes nothing) and the cursor still
advances. Its DB integration test needs BOTH the nexum page-revision schema and
the `0004_sharp_runtime_signal.sql` sharp migration applied. Prefer the
relative ordering assertion (`intent_spec_inference_runs_before_holistic_reconcile`)
over a hardcoded index, since later steps keep shifting the count.

## Project-graph create/update lives in `sf_db::project_graph`, not the studio crate

`update_node(pool, id, state, title)` (state ∈ `NODE_STATES` =
open/in_progress/validated/closed) backs BOTH `POST /studio/issues/update` and
`POST /studio/steer`. `list_nodes(pool, Some("Issue"|"Feature"))` backs the
list API + CLI. Don't re-implement node mutation in `sf-serve`/`sf-cli` — call
these. An invalid state returns `ProjectGraphError::InvalidState` → HTTP 400.

## `PgPool::close().await` deadlocks if a checked-out `PoolConnection` is still alive

In sf-db integration tests (e.g. `rls_workspace_isolation_integration.rs`),
`PgPool::close().await` waits for EVERY checked-out connection to be returned to
the pool before it resolves. A `let mut conn = pool.acquire().await?` binding
holds its connection until the local is dropped at end of scope. If you call
`pool.close().await` while such a local is still alive (even after
`tx.rollback()`/`tx.commit()`, which only ends the transaction — not the
connection checkout), `close()` blocks forever and the test hangs with no panic
and no DB activity (connections sit `idle` at `Client` wait). Symptom: the test
binary runs, provisions Postgres, applies migrations, then never prints a
`test result:` line. Fix: `drop(conn)` (and any second `conn2`) BEFORE
`pool.close().await`, or scope each acquired connection in its own `{ ... }`
block. The `LocalPostgresProvisioner` harness itself is fine — `provision_migrate_integration.rs` (which never holds a connection across `close()`) passes in ~4s.

## `LoopConfig` has a `llm_provider: LlmProvider` field (issue #748)

`crates/sf-loop/src/lib.rs`: `LoopConfig` gained `llm_provider` (the
`SF_LLM_PROVIDER` wire selector). Every struct literal must set it — the test
helpers in `crates/superfield/tests/daemon_loop_integration.rs` and
`crates/superfield/src/daemon_runtime.rs` (`config_with_key`) already do
(`sf_loop::LlmProvider::Anthropic`). Build the real executor with
`LlmAgentExecutor::with_provider(config.llm_provider, ...)`, not the bare
`::new` (which is now an Anthropic-only convenience). `LlmProvider` shaping is
pure (`provider.rs`) — unit-test request/response there, never via a network.

## `opencode/minimax-m2.5-free` is retired — use `opencode/big-pickle` (issue #748)

The free no-key CI loop model is OpenCode's Big Pickle (GLM-4.6),
`opencode/big-pickle`, via Zen's OpenAI-compatible endpoint
(`https://opencode.ai/zen/v1/chat/completions`, `OPENCODE_ZEN_API_KEY`). Do NOT
reintroduce `opencode/minimax-m2.5-free` in docs or config; `docs/runtime-agent-selection.md`
was corrected. `SF_LLM_PROVIDER=openai-compatible` selects this path.

## Per-scenario eval workflows are `heavy` class — schedule/dispatch only, no PR gate

`.github/workflows/eval-todo-app.yml` runs the WHOLE loop against a live model
(Big Pickle via Zen), so it is `CI_CLASS: heavy`: no `pull_request` trigger at
all, only `schedule:` + `workflow_dispatch:` (+ `push` to main on its own
paths). Adding a `pull_request` trigger fails `ci-taxonomy-lint.sh`. New
scenarios reuse this shape.
