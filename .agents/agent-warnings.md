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

**SUPERSEDED by #782/#783/#787:** `rust.yml` now runs Rust tests in CI, and
DB-gated integration tests must **EXECUTE and fail loudly**, NOT be `#[ignore]`d
to go green. Two new jobs make the old "no `cargo test`, so `#[ignore]` it"
guidance false and harmful:

- a REQUIRED `rust-test` job, check-run **"Rust workspace tests (nextest,
  no-tests=fail)"**, running `cargo nextest run --workspace --no-tests=fail`
  (exit 0 with zero tests collected is red); and
- a DB-provisioning `rust-test-seam` job (the `provision-test-substrate` path:
  pgvector + migrations + governed weights, #765/#782) so DB-gated tests run
  against a real substrate.

`#[ignore]`-ing a DB-gated test to pass CI is now exactly the silent-skip
anti-pattern banned by invariant 1 ("loud-skip, never silent-skip") of the four
executed-coverage invariants entry below (#787). The seam runs a CURATED,
purely-DB nextest filterset, not the whole `#[ignore]`d corpus — see the
"Curated nextest filterset hides a real DB-test failure class (#765/#764/#789)"
entry below for which classes are still excluded (and why) and the re-inclusion
conditions. Bottom line: write DB-gated tests so they execute and fail when the
DB/weights are absent; do not reach for `#[ignore]`.

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

## The keyless eval path is `opencode-server`, NOT the Zen HTTP key or `opencode run` (issue #748)

**SUPERSEDES the two entries above that say "Big Pickle via Zen,
`OPENCODE_ZEN_API_KEY`, `SF_LLM_PROVIDER=openai-compatible`".** The owner's
direction (2026-06-23): the eval live run is driven **keyless** — a fresh
`opencode` install reaches the free Big Pickle model with NO key and NO login, so
the workflow references no repo secret (blocker #752 "missing-opencode-zen-secret"
was closed invalid). Three hard-won facts:

- Drive the keyless provider `SF_LLM_PROVIDER=opencode-server`
  (`LlmProvider::OpenCodeServer`), which talks to a local `opencode serve` over
  its session API: `POST /session` (note: NO `/api` prefix for the mutating
  routes — `POST /api/session` falls through to the SPA HTML) then
  `POST /session/{id}/message`. The assistant text is in `parts[].text`; usage in
  `info.tokens.{input,output}`. The server base URL is `SF_OPENCODE_SERVER`
  (default `http://127.0.0.1:4096`), carried in `LoopConfig.llm_endpoint`.
- Do NOT use `opencode run` (the CLI) for capture: in non-interactive/piped mode
  it exits 0 but prints the assistant text to NEITHER stdout NOR stderr (only a
  TTY renderer gets it); even `--format json` emits just `step_start`. The text
  IS produced (it lands in the `part` SQLite table), but the only reliable
  programmatic capture is the `opencode serve` session API.
- Keyless providers are `Configured` even with empty `SF_LLM_API_KEY`:
  `LlmProvider::is_keyless()` gates `LoopConfig::credential_state()` and the
  executor's empty-key guard, so the loop selects the real `LlmAgentExecutor`,
  not the fixture. Mirror lives in `sf-serve`'s `StudioProvider::OpenCodeServer`.

## The four executed-coverage testing invariants — a green CI signal means "nobody objected," not "the code ran"

Canonical wording lives in `docs/testing-invariants.md` and the loop's
`_shared/test-coverage-policy.md`; both are guarded by the `Doc conformance`
job. A governed subsystem once merged green with zero executed CI coverage. Do
NOT add a test that would skip when its dependency is absent, and do NOT trust a
green job as proof the diff ran.

1. **Loud-skip, never silent-skip.** A test that needs an external resource (a
   DB, model weights, network, an API key) must **fail in CI when the resource
   is absent**, not skip. `#[ignore]`, `t.Skip()`, `@Disabled`,
   `skipif(not os.getenv(...))`, and fixtures returning `None`/`nil` when the
   resource is missing all produce a false green.
2. **Exit 0 ≠ tested.** A command that passes when zero tests ran proves
   nothing was exercised. Require evidence the diff was _executed_ — >0 tests
   collected and run — and make "no tests collected" red (`--no-tests=fail`,
   `--passWithNoTests=false`, `--strict-markers`).
3. **Runtime behaviour needs an executed-in-CI assertion.** Doc-grep, lint,
   type-check, format, and compile are **not** coverage for a model, endpoint,
   migration, or background job.
4. **Required checks must cover the languages present.** Every language present
   has a **test-executing** job in the required branch-protection contexts, not
   just a build job (`scripts/check-test-job-presence.sh`, #767).

## Curated nextest filterset hides a real DB-test failure class (#765/#764/#789)

The shared `provision-test-substrate` fixture (#765, PR #782) makes DB-gated
Rust tests EXECUTE, but `rust.yml`'s `rust-test-seam` runs a CURATED, purely-DB
nextest filterset (sf-db / sf-serve / sharp / superfield / sf-loop, asserting
`>0` each) — see the `cargo nextest run -p …` step near `rust.yml:~325`. A
sizeable fraction of the `#[ignore]`d DB-test corpus is EXCLUDED, and NOT
because it lacks a substrate: those tests FAIL against a correct one.

- **The three excluded, failing-against-correct-substrate classes:**
  1. tests asserting not-yet-implemented schema — the `workspace_id`
     NOT-NULL/FK back-fill (the appliance migration only self-ensures a
     _nullable_ `workspace_id` column; see `crates/sf-db/src/migrate.rs` and
     `crates/sharp/migrations/0009`);
  2. a `sharp` multi-statement-prepared bug;
  3. `sf-loop` page-revision writers that need a seeded `public.workspaces` row.
     Tracked in #764. The exclusion is invisible behind a green nextest signal, so
     it can calcify. Do NOT silently green these by widening the filterset before
     the underlying schema/bugs land (loud-skip, never silent-skip).
- **Re-inclusion conditions (un-curate the filterset when each lands):**
  - when the `workspace_id` NOT-NULL/FK back-fill schema lands → add the
    workspace_id-schema tests back to the seam filterset and assert `>0`;
  - when the `sharp` multi-statement-prepared bug is fixed → add those `sharp`
    tests back and assert `>0`;
  - when `sf-loop` page-revision writers seed a `public.workspaces` row → add
    those `sf-loop` tests back and assert `>0`.
    A future PR that lands any of these is EXPECTED to expand the
    `rust-test-seam` filterset (mirror this note at the `rust.yml` filterset site).
- **`check-coverage-truth.sh` `--workspace` over-claim risk:** the validator
  derives crate execution from `rust.yml`'s literal `cargo nextest run -p <crate>`
  invocation. Widening the seam to `cargo nextest run --workspace` bypasses the
  per-crate `-p` parser and would silently turn the five `>0` coverage-truth
  rows into over-claims. The parser MUST be updated in lockstep with any
  `--workspace` move; `tests/coverage-truth-selftest.sh` feeds a synthetic
  `--workspace` rust.yml (via `RUST_YML_OVERRIDE`) and fails LOUDLY if the five
  crates are still credited as executed-by-name without per-crate evidence.
