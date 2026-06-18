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
`GardeningStep::ProjectGraphDerive` as the 7th step (last in `STEP_ORDER`). Any
new test/doc that hard-codes the count must say 7 (see
`step_order_has_seven_entries`). The derive step writes the **project graph**
(`insert_issue`/`insert_feature`), not page revisions — so it does NOT touch
`nexum.page_revisions` and a DB integration test for it needs the
`0002_project_graph.sql` nexum migration applied, not the page-revision schema.

## Project-graph create/update lives in `sf_db::project_graph`, not the studio crate

`update_node(pool, id, state, title)` (state ∈ `NODE_STATES` =
open/in_progress/validated/closed) backs BOTH `POST /studio/issues/update` and
`POST /studio/steer`. `list_nodes(pool, Some("Issue"|"Feature"))` backs the
list API + CLI. Don't re-implement node mutation in `sf-serve`/`sf-cli` — call
these. An invalid state returns `ProjectGraphError::InvalidState` → HTTP 400.
