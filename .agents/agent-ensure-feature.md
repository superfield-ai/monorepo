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
