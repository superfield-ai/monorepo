# Scout #534 — Loop-Wiring Findings

**Phase:** loop-wiring-fixes  
**Issue:** [#534](https://github.com/superfield-ai/monorepo/issues/534)  
**Date:** 2026-06-13

---

## Summary

This scout examined three files to verify whether daemon-loop wiring (daemon
storing `LoopHandle` in `AppState`, calling `GardeningLoop::start()`, and
calling `drain()` on graceful shutdown) is implemented. It is **not**.

---

## File-by-file findings

### `crates/sf-serve/src/loop_handle.rs`

The module-level doc comment and an implementation-path block contain stale
references to unimplemented features.

#### Stale drain-route reference — lines 5–7

```rust
//! The trait lives in `sf-serve` because the HTTP
//! layer (orchestrator endpoints) also needs to be able to trigger a drain via
//! the `/orchestrator/drain` route.
```

**Status: false.** `crates/sf-serve/src/routes/orchestrator.rs` contains only
`GET /orchestrator/status`. There is no `/orchestrator/drain` route anywhere in
the codebase.

#### Stale implementation-path block — lines 32–51

The `# Implementation path (issue #491)` block describes unimplemented wiring:

- Line 46: "the orchestrator route `/orchestrator/drain` (issue #491) needs
  access to a `Arc<dyn LoopHandle>` stored in `sf_serve::AppState`"
- Lines 46–48: "Issue #491 must update `AppState` (in
  `crates/sf-serve/src/state.rs`) to carry an `Option<Arc<dyn LoopHandle>>`"

**Status: false.** `AppState` has no `LoopHandle` field (confirmed below).
These lines describe planned work that has not been done.

#### Lines that are correct (do not touch)

- Lines 56–103: `BoxFuture` alias, `LoopHandleError`, and `LoopHandle` trait —
  correct.
- Lines 109–136: `NoopLoopHandle` struct and impl — correct.
- Lines 142–167: unit tests — correct.

---

### `crates/sf-cli/src/daemon.rs`

Searched entire file (995 lines) for any call to `GardeningLoop::start()` or
`drain()`. **None found.** The daemon lifecycle module handles:

- Auto-spawn via `connect_or_start_daemon`
- Startup-notify handshake over Unix socket (`SF_STARTUP_NOTIFY`)
- Version-mismatch restart via `SIGTERM` + flock cycle
- `SF_NO_DAEMON=1` foreground mode

It does **not** call `GardeningLoop::start()` or store a `LoopHandle`.

---

### `crates/sf-serve/src/state.rs`

`AppState` is `Arc<Inner>`. `Inner` fields:

```rust
pub struct Inner {
    pub pool: PgPool,
    pub session_store: SessionStore,
}
```

**No `LoopHandle` field.** Confirmed: `AppState` carries no loop-control handle.

---

### `docs/architecture.md` §Gardening Loop Engine (line 436)

#### False sentence — line 452

> The daemon stores this handle in `AppState` and calls `drain()` on graceful
> shutdown (which sends a drain signal and waits for the loop to finish its
> current step before returning).

**Status: false** on two counts:

1. `AppState` has no such field.
2. The daemon does not call `drain()` — graceful shutdown uses `SIGTERM` and
   flock release.

#### Accurate content (do not touch)

- `GardeningStep` variants table (lines 468–476) — accurate.
- `AgentExecutor` trait (lines 479–492) — accurate.
- `BlueprintRules` (lines 494–505) — accurate.
- Cursor resume (lines 507–521) — accurate.

---

## Integration risks captured for downstream issues

### For #531 (`fix(sf-serve): remove stale lines in loop_handle.rs`)

| Lines | Content                                                               | Action            |
| ----- | --------------------------------------------------------------------- | ----------------- |
| 5–7   | `/orchestrator/drain` HTTP-route justification                        | Rewrite           |
| 32–51 | `# Implementation path` block with stale route and `AppState` details | Remove or replace |

### For #533 (`docs(architecture): correct §Gardening Loop Engine`)

Replace line 452 paragraph with accurate wording that marks the wiring as
planned but not yet implemented (pending #489 + #491).

### For #532 (`chore(plan): mark completed phases in Plan #199`)

Both target phases are fully closed:

- **docs-drift-baseline**: #503, #504, #505, #506, #507, #509 — all CLOSED
- **architecture-completeness**: #519, #520, #521, #522, #523, #524 — all CLOSED

---

## What IS implemented (correct baseline)

| Component                                                                    | Status                       |
| ---------------------------------------------------------------------------- | ---------------------------- |
| `crates/sf-loop/` — loop engine, steps, cursor, blueprint                    | Implemented                  |
| `crates/sf-serve/src/loop_handle.rs` — `LoopHandle` trait + `NoopLoopHandle` | Implemented (stub)           |
| `crates/sf-cli/src/daemon.rs` — daemon lifecycle                             | Implemented (no loop wiring) |
| `AppState` carries `LoopHandle`                                              | **Not implemented**          |
| Daemon calls `GardeningLoop::start()`                                        | **Not implemented**          |
| `/orchestrator/drain` HTTP route                                             | **Not implemented**          |
| Daemon calls `drain()` on shutdown                                           | **Not implemented**          |
