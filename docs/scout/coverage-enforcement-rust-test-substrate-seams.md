# Dev-Scout Findings: the shared Rust-test CI seam — nextest invocation/config, the reusable pgvector+weights substrate, and the per-package executed-count source

**Issue:** #771 (scout) — pins the one shared seam the three coverage-enforcement features all edit
**Phase:** coverage-enforcement
**Scout date:** 2026-06-25
**Canonical docs:** `docs/prd.md`, `docs/adr-schema-boundary.md`, `docs/adr-embedding-model.md`
**Downstream issues:**

| Issue | Feature                                                                      | What this scout pins for it                                                                                      |
| ----- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| #765  | Shared pgvector DB + governed-weights fixture so DB-gated Rust tests execute | The `provision-test-substrate` composite-action interface + the EXACT reuse path from the merged #760 artifacts. |
| #764  | Required `cargo nextest run --workspace` with `no-tests-collected=fail`      | The nextest invocation + `.config/nextest.toml` `[profile.ci]` + which job becomes the required context.         |
| #766  | Coverage-delta gate — touching a package requires >0 of its tests to run     | The per-PACKAGE executed-test count source (nextest libtest-json) + the `coverage-truth.toml` package map.       |

This is a **stub-only / documentation** pass. It introduces **no** change to
runtime behaviour and makes **nothing** a required context. The artifacts shipped
here are compile-safe / lint-clean stubs:

- `.config/nextest.toml` — config skeleton with a `default` and a `ci` profile.
- `.github/actions/provision-test-substrate/action.yml` — composite-action
  skeleton; **no-op in `stub` mode** (the default).
- `rust.yml` `rust-test-seam` job — a NON-required job that proves nextest
  resolves, runs one DB-free crate (`sf-auth`) green, references the substrate
  action (grep AC), and prints the per-package count map #766 will consume.

> **Loud-skip invariant (phase thesis).** Every stub fails LOUDLY, never
> silently. The trivial nextest step asserts `>0 tests executed` and `exit 1`s
> on zero; `--no-tests=fail` is passed explicitly; the substrate action's
> `provision` path `exit 1`s rather than skip; the JSON extractor `exit 1`s on
> an empty map. No stub bakes in a silent-skip. Where the real enforcement
> (required contexts, the gate) wires in is marked below and in each file.

---

## 1. nextest invocation + config (pin for #764)

### 1.1 The load-bearing flag

`rust.yml` today only **builds** the workspace (`cargo build --workspace`) — no
job RUNS the Rust suite. Invariant 2 ("exit 0 != tested") is unmet for Rust.
#764 makes `cargo nextest run --workspace` a required context. The load-bearing
flag is **`--no-tests=fail`**: nextest must hard-fail when a run collects zero
tests, so an empty/mis-filtered run can never pass green.

> In the pinned toolchain **cargo-nextest 0.9.85**, `--no-tests=fail` is the
> **default** (verified: `cargo nextest run --help` → `--no-tests=<ACTION>
[default: fail]`). #764 MUST still pass it **explicitly on the command line**
> so (a) the enforcement is visible in the workflow and (b) it survives a future
> nextest default change. `--no-tests` has **no `[profile]` equivalent** in this
> version, so it lives on the command line, not in `.config/nextest.toml`.

### 1.2 The `.config/nextest.toml` `[profile.ci]` (shipped here)

The config skeleton pins the run shape #764 selects with `--profile ci`:
`retries = 0` (deterministic — a flake is real signal in this phase),
`fail-fast = false` (collect EVERY package's executed count in one run so #766
sees them all, not just up to the first failure), `failure-output =
immediate-final`, and a CI slow-timeout. It also pins
`nextest-version = { required = "0.9.85" }`.

### 1.3 The #764 invocation (pinned)

```bash
cargo nextest run --workspace --profile ci --no-tests=fail
```

The scout `rust-test-seam` job runs the same line scoped to `-p sf-auth`
(§4). #764 widens `-p sf-auth` → `--workspace` AND adds the substrate (§2)
because the workspace run touches DB/embedder-gated tests.

### 1.4 The self-check #764 owes

#764's AC requires a self-check proving `--no-tests=fail` is active: run nextest
with a filter that matches nothing and assert a NON-zero exit, e.g.
`cargo nextest run -E 'test(/__nonexistent__/)' --no-tests=fail` → expect exit 1.

---

## 2. The reusable pgvector + governed-weights substrate (pin for #765)

### 2.1 Both halves already exist on `main` — REUSE, do not reinvent

#765 must stand up pgvector + DATABASE_URL + migrations + governed weights for a
full Rust-test job. **Both mechanisms are already merged (issue #760):**

1. **Governed weights (OFFLINE):** `.github/actions/governed-embed-weights`
   (composite action). It restores/populates the hf-hub cache keyed on
   `models/embedding.lock` and PROVES offline resolution. The Rust `hf-hub`
   0.3.2 crate has **no offline switch** (`HF_HUB_OFFLINE` is Python-only); the
   only lever is pre-populating the cache so the cache-HIT branch is taken. See
   the prior scout `docs/scout/embedding-coverage-offline-weights-and-pgvector-seams.md`
   for the full mechanism. **#765 calls this action as a step** —
   `uses: ./.github/actions/governed-embed-weights` is allowed inside a
   composite action. Do NOT re-implement the curl/refs/snapshots dance.

2. **pgvector + DATABASE_URL + migrations:** `.github/workflows/embedder-coverage.yml`
   is the working pattern. It declares a `pgvector/pgvector:pg16` **service**,
   sets `DATABASE_URL=postgres://superfield:superfield@postgres:5432/superfield`
   (host is the service name because the job runs in a container), does a
   `/dev/tcp` reachability probe (the ci-runner image ships **no** libpq /
   `pg_isready` / `psql`), runs `bun install --frozen-lockfile`, then
   `bun packages/db/migrate.ts up` to apply the FULL migration set:
   `public -> auth -> nexum -> sharp -> orchestrator`. The `orchestrator`
   directory is now registered in both runners (`crates/sf-db/src/migrate.rs`
   and the TS migrator), so a fresh DB carries the orchestrator cursor schema.

### 2.2 The hard constraint: a `services:` block CANNOT live in a composite action

GitHub `services:` are declared on the **job**, not on a composite action. So
the factoring is:

- **Job level (in `rust.yml`, #765):** the `pgvector/pgvector:pg16` service, the
  `container: ghcr.io/superfield-ai/ci-runner:latest` image, and the
  `DATABASE_URL` env — mirroring `embedder-coverage.yml`.
- **Composite action (`provision-test-substrate`, #765 fills in):** the REUSABLE
  inner provisioning — the `/dev/tcp` probe, `bun … migrate.ts up`, and
  `uses: ./.github/actions/governed-embed-weights`. It takes the job-level
  `database-url` as an input and echoes it back as an output.

The skeleton shipped here encodes exactly this: `mode: stub` (default) is a
no-op that exits 0; `mode: provision` carries `[#765] WIRE HERE` steps (probe →
migrate → weights). The probe step `exit 1`s in this scout so the unwired path
fails loudly rather than masquerading.

### 2.3 Crates the substrate unblocks

Per #765: `sf-db, sf-serve, sharp, superfield, sf-loop` (DB-gated, currently
`#[ignore]`/`maybe_pool`-skipped) plus `nexum` (already executed by
`embedder-coverage.yml`). Under the substrate, `cargo nextest run --workspace
--include-ignored` (or per-crate `-p …`) executes those instead of skipping.
The DB-gated tests are gated via `#[ignore = "integration: requires
DATABASE_URL …"]` (e.g. `crates/sf-auth/src/session.rs:290,322,349`) and the
`maybe_pool()` early-return pattern; with `DATABASE_URL` set + migrations
applied + `--include-ignored`, they run.

---

## 3. The per-package executed-count source (pin for #766)

#766's coverage-delta gate maps a PR's changed paths to owning packages, then
asserts each touched package ran `>0` of its tests. It needs **per-package
EXECUTED** counts (not collected, not from `.config/nextest.toml`).

### 3.1 Source: nextest libtest-json events

Run with `NEXTEST_EXPERIMENTAL_LIBTEST_JSON=1` and
`--message-format libtest-json`. nextest emits NDJSON; the load-bearing events:

- **per-test:** `{"type":"test","event":"ok"|"failed"|"ignored","name":"<pkg>::<binary>$<path>", …}`
  — the owning **package** is the prefix before the first `::`. Counting
  `ok` + `failed` events per package gives the **executed** count (ignored
  excluded, which is what the gate wants — a skipped test did not "run").
- **per-suite:** `{"type":"suite","event":"started","test_count":N}` and a
  terminal `{"type":"suite","event":"ok","passed":P,"failed":F,"ignored":I,…}`
  — `P+F` is that suite's executed count.

Verified locally on `sf-auth`: the `started` event reports `test_count:15`; the
terminal suite event reports `passed:3, failed:0, ignored:3, filtered_out:9`
under a filter; counting per-test `ok`/`failed` events yields the per-package
executed map. The shipped `rust-test-seam` job prints this map (`{sf-auth: 12}`
on a full unfiltered run) to PROVE the extraction.

### 3.2 The package map: `coverage-truth.toml` + `scripts/check-coverage-truth.sh`

The path→package map #766 needs is already on `main`: `coverage-truth.toml`
(repo root) has one `[[unit]]` row per `crates/*` and `packages/*` dir with a
`path`, `kind`, and `tests_executed_in_ci` floor; `scripts/check-coverage-truth.sh`
validates it against reality. #766 should derive "which package owns this
changed file" from those `path` prefixes, then look up the per-package executed
count from §3.1. The manifest already records `crates/nexum` as
`tests_executed_in_ci = 11` (executed by `embedder-coverage.yml`); after #765
the named DB-gated crates flip `0 → >0` and #765 updates their rows.

### 3.3 The self-test #766 owes

#766's AC requires `scripts/check-coverage-delta.sh` to exit non-zero for a
synthetic PR touching package X with a zero executed-X count, and zero for a

> 0 count. Feed it a synthetic changed-file list + a synthetic per-package
> count report (the §3.1 map shape) — no live CI needed.

---

## 4. The `rust.yml` edit targets — land #765 → #764 → #766 WITHOUT conflict

All three features edit `rust.yml`. The scout pins a single `rust-test-seam`
job (added by this scout) as the shared anchor so the edits are **additive and
sequential**, not overlapping:

| Order | Issue | Edit to `rust.yml` (and friends)                                                                                                                                                                                                                                                                                                                 |
| ----- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | #765  | On `rust-test-seam`: add the `services: postgres (pgvector/pgvector:pg16)` block + `DATABASE_URL` env (mirror `embedder-coverage.yml`); flip the substrate step `mode: stub → provision` and pass `database-url`; fill `provision-test-substrate/action.yml` WIRE-HERE steps. Update the `coverage-truth.toml` rows for the now-executed crates. |
| 2     | #764  | On `rust-test-seam`: widen the trivial step from `-p sf-auth` to `--workspace --include-ignored`; rename the job so its context is stable; register that context in `main`'s branch protection; add the empty-filter self-check (§1.4). The `[profile.ci]` is already in `.config/nextest.toml`.                                                 |
| 3     | #766  | Add a `coverage-delta` step/job consuming the §3.1 per-package JSON (already emitted by `rust-test-seam`) + `coverage-truth.toml`; ship `scripts/check-coverage-delta.sh` + its self-test; register the gate context.                                                                                                                            |

Because #765 only ADDS the service block + flips the action mode, #764 only
WIDENS the run + registers a context, and #766 only ADDS a downstream
consumer, the three never edit the same lines. Order matters (#764's workspace
run needs #765's DB; #766's gate needs #764's run), but the FILE regions are
disjoint.

---

## 5. What this scout does NOT do (downstream features' job)

- Make any nextest job a required branch-protection context (#764).
- Provision a real DB or fetch real weights — `provision-test-substrate` is
  `stub`/no-op (#765).
- Implement the coverage-delta gate or `scripts/check-coverage-delta.sh` (#766).
- De-ignore any test or convert any `maybe_pool()` silent-skip (that is the
  embedding-coverage phase / #761, already landed for nexum).
