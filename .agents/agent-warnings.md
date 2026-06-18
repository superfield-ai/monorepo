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
