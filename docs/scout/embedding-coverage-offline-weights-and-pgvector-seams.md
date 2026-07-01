# Dev-Scout Findings: offline governed-weights mechanism, pgvector CI provisioning, and the nexum embed/test edit seams

**Issue:** #770 (scout) — pins the two shared unknowns for #760, #761, #762, #763
**Phase:** embedding-coverage-proof
**Scout date:** 2026-06-24
**Canonical docs:** `docs/adr-embedding-model.md`; `models/embedding.lock`
**Downstream issues:**

| Issue | Feature                                                                                                 | What this scout pins for it                                                                                             |
| ----- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| #760  | Required real-embedder job (pgvector + governed weights run nexum integration + embed.rs ignored tests) | The offline-weights mechanism, the pgvector provisioning, the `--include-ignored` invocation, and the exact test seams. |
| #761  | Convert embedder/DB silent skips to loud CI failures                                                    | The exact `maybe_pool()` silent-skip and `#[ignore]` lines to rewrite, and where the loud-fail guard goes.              |
| #762  | Provision governed weights for `eval-todo-app` Seed (fix `Embedder::new` `RelativeUrlWithoutBase`)      | The exact pre-population step to insert before the garden Seed step in `eval-todo-app.yml`.                             |
| #763  | Replace the manual embedder verify in `.agents/agent-ensure-feature.md` with the CI-backed command      | The CI job/command the manual verify (L161) is replaced by.                                                             |

This is a **stub-only / documentation** pass. It introduces **no** change to
runtime behaviour. `cargo build -p nexum` and `cargo test -p nexum` pass
unchanged; the embedder is **not** invoked, no test is de-ignored, and nothing
is registered as a required context. The composite action and probe shipped
here are **compile-safe / lint-clean stubs** — wiring them into a required job,
into `eval-todo-app.yml`, and converting the silent skips is the downstream
features' job.

> **Loud-skip invariant (phase thesis).** Nothing in this scout bakes in a
> silent-skip. The `maybe_pool()` early-return and the `#[ignore]` markers are
> the _existing_ silent-skip pattern this phase exists to remove. This note
> documents where the loud-fail wiring goes (§4); it does **not** add a new
> skip and it does **not** remove the existing one (that is #761).

---

## 1. The critical finding: the Rust `hf-hub` crate does NOT honor `HF_HUB_OFFLINE`

The single most important fact for the whole phase:

> **`hf-hub` 0.3.2 (the version in `Cargo.lock`) has no offline switch.**
> Setting Python's `HF_HUB_OFFLINE=1` / `TRANSFORMERS_OFFLINE=1` does **nothing**
> in Rust. The crate never reads those variables.

`Embedder::new()` (`crates/nexum/src/embed.rs:141`) calls `repo.get("config.json")`
(and `tokenizer.json`, `model.safetensors`). Tracing `get` through the crate
source (`~/.cargo/registry/src/.../hf-hub-0.3.2/`):

```rust
// hf-hub-0.3.2 src/api/sync.rs:420
pub fn get(&self, filename: &str) -> Result<PathBuf, ApiError> {
    if let Some(path) = self.api.cache.repo(self.repo.clone()).get(filename) {
        Ok(path)              // ← cache HIT: returns a local path, no network
    } else {
        self.download(filename)  // ← cache MISS: hits huggingface.co
    }
}
```

So resolution is **cache-first, then network**. There is no offline flag and no
loud failure on a miss — a miss silently falls through to `download()`, which
calls `self.api.metadata(&url)`. On a runner with no network (or a blocked
egress, or — as observed in the `eval-todo-app` Seed step — an environment
where the endpoint resolves empty) that download produces the exact error the
phase is chasing:

> `RelativeUrlWithoutBase` (the `eval-todo-app` Seed failure, MEMORY:
> `eval-todo-app-ci-chain`).

**Therefore the mechanism is: pre-populate the cache so the cache-HIT branch is
taken and `download()` is never reached.** There is no env var that disables
the network; the only lever is making the file present at the exact path
`cache.get()` looks for.

### 1.1 The exact cache layout `cache.get()` requires (fully pinned)

`cache.get()` does **not** look directly under a revision directory. It
resolves the revision through a `refs/` file first
(`hf-hub-0.3.2 src/lib.rs:137`):

```rust
pub fn get(&self, filename: &str) -> Option<PathBuf> {
    let commit_path = self.ref_path();                 // <root>/<repo>/refs/<revision>
    let commit_hash = std::fs::read_to_string(commit_path).ok()?;  // full 40-char SHA
    let mut pointer_path = self.pointer_path(&commit_hash);        // <root>/<repo>/snapshots/<full-sha>
    pointer_path.push(filename);
    if pointer_path.exists() { Some(pointer_path) } else { None }
}
```

Pinned facts, derived from the crate source:

| Element              | Value                                                                       | Source                                                                                                      |
| -------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Cache **root**       | `$HF_HOME/hub`, else `~/.cache/huggingface/hub`                             | `src/lib.rs:194` (`Default for Cache`) — note `HF_HOME` is the only env var honored; it then appends `hub`. |
| Repo **folder name** | `models--sentence-transformers--all-MiniLM-L6-v2`                           | `folder_name()` `src/lib.rs:247` — `format!("models--{repo_id}").replace('/', "--")`.                       |
| **refs file**        | `<root>/<repo>/refs/c9745ed` containing the **full commit SHA**             | `ref_path()` `src/lib.rs:155`; revision = `GOVERNED_MODEL_REVISION = "c9745ed"`.                            |
| **snapshot dir**     | `<root>/<repo>/snapshots/<full-commit-sha>/`                                | `pointer_path()` `src/lib.rs:184`.                                                                          |
| Required **files**   | `config.json`, `tokenizer.json`, `model.safetensors` under the snapshot dir | the three `repo.get(...)` calls in `embed.rs:151-159`.                                                      |

So the full minimal tree the mechanism must materialise (with `HF_HOME=$HOME/.cache/huggingface`, i.e. the default):

```
~/.cache/huggingface/hub/
└── models--sentence-transformers--all-MiniLM-L6-v2/
    ├── refs/
    │   └── c9745ed                         # text file: the FULL 40-char commit SHA
    └── snapshots/
        └── <full-commit-sha>/
            ├── config.json
            ├── tokenizer.json
            └── model.safetensors
```

> **Gotcha for #760/#762:** `c9745ed` is the _short_ SHA used as the revision
> string. The `refs/c9745ed` file must contain the **full** commit SHA, and
> the `snapshots/<...>` directory must be named with that **full** SHA — the
> short SHA is only the refs _filename_. Pin the full SHA when authoring the
> bake step (resolve it once from the Hub, then commit it / cache it). A real
> hf-hub download writes both files automatically, so the simplest bake is: do
> ONE online `Embedder::new()` on a populate runner, then `actions/cache` the
> resulting `~/.cache/huggingface/hub/**` tree keyed on `models/embedding.lock`.

### 1.2 How to make the weights present offline (the two viable mechanisms)

Both downstream issues (#760 the required job, #762 the eval) want the same
tree present with **no `huggingface.co` egress at `Embedder::new()` time**.

**Mechanism A — `actions/cache` keyed on the lockfile (recommended, no secret).**
A populate step does one online resolve (allowed only on cache miss), and every
subsequent run restores the tree from cache and runs fully offline. Key the
cache on `hashFiles('models/embedding.lock')` so a revision bump invalidates it.

**Mechanism B — bake into the `ci-runner` image.** Add the snapshot tree to
`ghcr.io/superfield-ai/ci-runner` so every container starts with the cache
warm. Heavier to rebuild but zero per-run resolve. Out of scope to build here;
named as the alternative.

The stub composite action shipped at
`.github/actions/governed-embed-weights/action.yml` implements **Mechanism A**
as a compile-safe, no-op-on-hit skeleton. It is **not** wired into any workflow
by this scout.

### 1.3 The offline-resolution probe

`crates/nexum/tests/offline_weights_probe.rs` is a `#[ignore]`d probe (so it
never runs in the default suite and changes no behaviour) documenting how a
downstream job verifies offline resolution: with the cache pre-populated and
network disabled, `Embedder::new()` must return `Ok` and resolve all three
files without touching the network. The probe asserts the _path_ contract, not
inference, and is the seam #760's `--include-ignored` job turns on.

---

## 2. pgvector Postgres + `DATABASE_URL` CI provisioning (pinned)

The integration suite is `DATABASE_URL`-gated (see §3). The canonical
provisioning pattern already lives in the repo — `ci-migrate.yml:37-55` and
`eval-todo-app.yml:35-61` both stand up `pgvector/pgvector:pg16` as a job
`service` and export
`DATABASE_URL=postgres://superfield:superfield@postgres:5432/superfield`.

Pinned facts:

| Concern         | Pinned value                                                                                                    | Source                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Image           | `pgvector/pgvector:pg16` (ships the `vector` extension nexum's `vector(384)` columns need)                      | `ci-migrate.yml:41`, `eval-todo-app.yml:39` |
| Service host    | `postgres` (service name; jobs run **inside** the `ci-runner` container, so `localhost` is wrong)               | `eval-todo-app.yml:32`, `:61`               |
| `DATABASE_URL`  | `postgres://superfield:superfield@postgres:5432/superfield`                                                     | `ci-migrate.yml:55`                         |
| Health gate     | `pg_isready -U superfield -d superfield`, 5–10s interval, 10 retries                                            | `ci-migrate.yml:46-50`                      |
| Migration apply | `bun packages/db/migrate.ts up` — applies **all** component migrations in order `public → auth → nexum → sharp` | `packages/db/migrator.ts:13,157-158,221`    |

So the nexum migration set (`crates/nexum/migrations/0001..0003`) is applied by
the **same** `bun packages/db/migrate.ts up` the existing migrate job uses; the
downstream embedder job does not need a bespoke migrator. The stub job
`.github/workflows/embedder-coverage.yml` (disabled — `workflow_dispatch` only,
`CI_CLASS: heavy`) carries the service block, a `pg_isready`/psql ping step
(satisfies the scout's connect probe), and a commented-out skeleton of the
governed-weights restore + `--include-ignored` test run for #760 to fill in.

---

## 3. The edit seams (exact lines/functions each downstream issue edits)

So #760 and #761 do not conflict, here is who edits what.

### 3.1 `crates/nexum/tests/integration.rs` — the `maybe_pool()` silent-skip

```rust
// integration.rs:42-51  (the silent-skip the phase exists to remove)
async fn maybe_pool() -> Option<PgPool> {
    let url = std::env::var("DATABASE_URL").ok()?;   // ← silent early-return on None
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect(&url)
        .await
        .expect("failed to connect to DATABASE_URL");
    Some(pool)
}
```

Every test then does `let pool = match maybe_pool().await { Some(p) => p, None => return };`
— the `None => return` is the silent skip. Call sites returning early:
`integration.rs` lines **240, 301, 381, 448, 509, 577, 675, 747, 818** (and any
added later). Confirm with `grep -n "maybe_pool().await" crates/nexum/tests/integration.rs`.

| Issue                   | Edits here                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#761** (loud-skip)    | **Owns this function.** Replace the `?` silent early-return with a require-marker-gated hard fail: when a CI marker env (e.g. `NEXUM_REQUIRE_DB=1`) is set, a missing `DATABASE_URL` must `panic!`/return a failing result (non-zero exit), **not** `None`. With the marker unset (local dev) it still returns `None` and skips. Keep the `None`-skip path only for the unset-marker case. Add a dedicated `#[test]` asserting the guard fails when the marker is set and `DATABASE_URL` is unset (AC of #761). **Do not** change the call-site `match … None => return` shape — only the guard semantics inside `maybe_pool()`. |
| **#760** (required job) | **Does NOT edit this function.** It sets `DATABASE_URL` (and, post-#761, the require-marker) in the workflow so `maybe_pool()` returns `Some` for real and the suite executes. It edits **CI only**, not this file.                                                                                                                                                                                                                                                                                                                                                                                                              |

> Ordering note: if #761 lands first, #760's job must export the require-marker
> so the loud guard is active. If #760 lands first, it runs with the existing
> silent-skip semantics (tests execute because `DATABASE_URL` is set) and #761
> adds the guard afterward. Either order is conflict-free because they touch
> disjoint layers (Rust guard vs. workflow env).

### 3.2 `crates/nexum/src/embed.rs` — the `#[ignore]` unit tests

```rust
// embed.rs:269-328  mod tests
#[test]
#[ignore = "downloads model weights from HuggingFace Hub"]   // ← lines 276, 294, 315
fn embed_returns_governed_dimension() { … }     // 275-289
fn embed_is_deterministic() { … }               // 293-310
fn embed_batch_returns_correct_count() { … }     // 314-327
```

The three `#[ignore]` attributes are at lines **276, 294, 315**.

| Issue                   | Edits here                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#760** (required job) | Runs these via `cargo test -p nexum --include-ignored` (or the equivalent) in the provisioned job — **without** removing `#[ignore]** (they stay `#[ignore]`for local default runs; CI opts in with`--include-ignored`). It asserts `embed_returns_governed_dimension` executes and passes. The job, not this file, changes.                                                                        |
| **#761** (loud-skip)    | Makes `embed_returns_governed_dimension` _loud-fail_ when weights are absent under the require-marker. Two options it must choose between (pin in #761): (a) de-ignore it and gate the skip on the marker like §3.1; or (b) keep `#[ignore]` and add a separate marker-gated `#[test]` that asserts weights are present. Update the `#[ignore = "..."]` reason strings if it changes the semantics. |

> The two features touch **different** aspects of the same `mod tests`: #760
> only changes the _invocation_ (CI flag), #761 changes the _skip semantics_
> (the attribute / a guard). To stay conflict-free, **#761 owns any edit to the
> `#[ignore]` attributes and test bodies; #760 owns only the workflow.** If
> both need to touch `embed.rs`, #761 goes first.

### 3.3 `eval-todo-app.yml` — the Seed step (for #762)

The failing step is **"Seed the todo-app intent"** (`eval-todo-app.yml:161-166`),
which runs `garden`, which calls `Embedder::new()`. The fix (#762) inserts the
governed-weights restore (Mechanism A, §1.2) **before** that step (e.g. right
after "Install stable toolchain", `:70-71`, and before/alongside the build step
`:133`). The workflow already provisions pgvector (`:35-61`), so #762 only adds
the weights, not the DB.

### 3.4 `.agents/agent-ensure-feature.md` — the manual verify (for #763)

The manual embedder verify is at `.agents/agent-ensure-feature.md:161`
(`DATABASE_URL=… cargo test -p sharp -p nexum -- --ignored --test-threads=1 …`;
related occurrences at `:42` and `:82`). #763 replaces the embedder portion of
this manual command with a pointer to the required CI job (#760) and its
`cargo test -p nexum … --include-ignored` command, and adds a doc-conformance
assertion that the manual `cargo test -p nexum -- --ignored` form does not
reappear. #763 depends on #760 existing (so there is a named job to point at).

---

## 4. Where the loud-fail wiring goes (so the phase thesis holds)

The phase's whole point is **loud-skip, never silent-skip**. The two existing
silent skips and their loud-fail destinations:

1. **`maybe_pool()` → `None` (DB absent).** Loud-fail destination: the
   require-marker guard inside `maybe_pool()` (§3.1), owned by #761. The
   required job (#760) sets the marker so the guard is armed in CI.
2. **`#[ignore]` on embed tests (weights absent).** Loud-fail destination: the
   marker-gated assertion that weights resolve offline (§3.2 / the probe in
   §1.3), owned by #761; executed by #760's `--include-ignored` run.

Neither is wired by this scout — doing so is feature work and would change
runtime/CI behaviour. This note pins the destinations so the features land
without re-discovering them.

---

## 5. Scout deliverables in this PR (all compile-safe, behaviour-neutral)

> **IMPLEMENTED in #760 / #761 / #762.** The seams pinned below have since
> landed and this table is a point-in-time record. `embedder-coverage.yml` is
> now a gated job (push + PR + nightly, `NEXUM_REQUIRE_DB=1`) that executes the
> `#[ignore]`d embedder tests via `--include-ignored` with governed offline
> weights; the `governed-embed-weights` action is referenced by both
> `embedder-coverage.yml` and `eval-todo-app.yml`; and the `maybe_pool()`
> silent-skip was replaced by the loud `NEXUM_REQUIRE_DB` guard in
> `crates/nexum/tests/integration.rs`. The "not referenced / manual dispatch
> only / silent-skip" statuses below no longer hold.

| Path                                                                  | Purpose                                                                                                                               | Active?                              |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `docs/scout/embedding-coverage-offline-weights-and-pgvector-seams.md` | This note.                                                                                                                            | doc only                             |
| `.github/actions/governed-embed-weights/action.yml`                   | Stub composite action: Mechanism A skeleton (cache-restore the snapshot tree keyed on `models/embedding.lock`; no-op on hit).         | **not referenced by any workflow**   |
| `.github/workflows/embedder-coverage.yml`                             | Stub job: pgvector service + `pg_isready` ping + commented `--include-ignored` skeleton. `workflow_dispatch` only, `CI_CLASS: heavy`. | **manual dispatch only; not a gate** |
| `crates/nexum/tests/offline_weights_probe.rs`                         | `#[ignore]`d probe documenting the offline path contract `Embedder::new()` must satisfy.                                              | `#[ignore]` — never runs by default  |

Nothing here is a required context, runs the real embedder in the default
suite, or alters `embed.rs`/`integration.rs` behaviour.
