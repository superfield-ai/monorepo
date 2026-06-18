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
