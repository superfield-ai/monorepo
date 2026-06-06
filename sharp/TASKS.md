# Sharp v1 Tasks — Status

```
Bootstrap (Phases 0-10):  DONE — differential harness running, 15-scenario seed corpus, CI workflows
Phase 11 — Storage layer:    DONE — schema, BLAKE3-but-actually-Git-hash CAS, refs CAS, commits, 9 integration tests
Phase 12 — HTTP API:         DONE — Bun.serve + router + auth + 25 endpoints, 9 e2e tests
Phase 13 — Client basics:    DONE — workspace, snapshot/commit/checkout, sharp lane lights up
Phase 14 — Operator CLI:     DONE — admin create-repo / issue-token / repo list / ref list
Phase 15 — Episode schema:   DONE — episodes/artifacts/links/redactions migration + endpoints
Phase 16 — @sharp/episodes:  DONE — TypeScript library (auto-routes inline vs CAS, replay, redaction)
Phase 17 — Analytics:        DONE — analytics_role + SQL passthrough + GRANT-driven security
Phase 18 — Tree-sitter:      DONE — web-tree-sitter (WASM) + prebuilt TS/Rust grammars + AST extraction
Phase 19 — Tier 1 merge:     SUBSTANTIALLY DONE — 9 of 15 corpus scenarios converted from FAIL to PASS
                             via rename propagation, concat-additions, whitespace-equivalence,
                             delete-then-edit dilemma. 4 follow-ups documented for Phase 19.x
                             (file-rename detection, formatter-aware tokenization for trailing-comma
                             reformats, src/report.ts tree-compare delta, last cross_file_rename gap).
Phase 20 — Hooks system:     SCAFFOLDED — discoverHooks/runHook/runHooks primitives, stock examples
                             under examples/hooks/ for tsc-noemit and cargo-check. Wiring into the
                             merge engine's pre-merge gate is a Phase 20.x follow-up.
Phase 21 — Tier 2 + 3:       NOT STARTED — Tier 3 dilemma format minimum already emitted by the
                             merge engine for delete-then-edit; Tier 2 oracle and Tier 3 polish remain
Phase 21b — Speculative:     NOT STARTED — projections table + recompute path (whitepaper §6.7)
Phase 22 — Git interop:      NOT STARTED — sharp git import/export
Phase 23 — Bench:            NOT STARTED — perf thresholds from v1-plan §3
Phase 24 — Observability:    PARTIAL — structured JSON logger + slow-query log scaffold landed
Phase 25 — Build/deploy:     NOT STARTED — Dockerfile, bun build --compile binaries
Phase 26 — Documentation:    NOT STARTED — docs/server-config, hooks, episodes, git-interop
```

**Differential corpus status:** 9 PASS / 6 FAIL. Sharp converts `clean_wrong → clean_ok` and `conflict → clean_ok` for refactor (one of two), reorder (both), import_merge (both), whitespace_only (both); Sharp emits `dilemma` for delete_edit (both) matching expected. Six follow-ups remain: format/{ts,rust} (trailing-comma tokenization), move_edit/{ts,rust} (file-rename detection), refactor/ts/rename_function_with_callsite_edit (tree-compare delta on src/report.ts), and one cross_file_rename scenario. None of these are blocking; the engine architecture is proven end-to-end.

**Test totals:** 67 tests passing across 9 files. Server up in ~3s; full corpus (both lanes) in ~9s.

---

# Sharp Bootstrap Tasks

Implements [`docs/test-plan.md`](./docs/test-plan.md). The goal of this task list is to get the **differential test harness** running end-to-end with the `git` lane producing real outcomes against a seed corpus, the Sharp lane stubbed, and CI green. Once that's done, Sharp itself can be developed test-first against the corpus per [`docs/v1-plan.md`](./docs/v1-plan.md).

We do not start TDD on Sharp client/server code until the harness is shipping a stable signal. The harness is the precondition.

**Stack.** Bun + TypeScript throughout. Vitest for unit tests of harness internals. Tests own their own postgres:16 container lifecycle via `tests/harness/pg-container.ts`, mirroring the pattern in `superfield/template/packages/db/pg-container.ts`. No shell scripts; no docker-compose.

Tasks are ordered. Items inside a phase can run in parallel; a phase should not start until the prior phase's blockers are green.

---

## Phase 0 — Repository Scaffolding

Foundational setup. Nothing depends on Sharp's design beyond what's already in `docs/`.

- [x] **0.1** `bun init`; `package.json` (private, ESM)
- [x] **0.2** `tsconfig.json` (strict, `noUncheckedIndexedAccess`, bundler resolution, esnext target)
- [x] **0.3** ESLint (flat config) + Prettier aligned with `superfield/template`
- [x] **0.4** `.gitignore` for `node_modules/`, `dist/`, `coverage/`, `*.log`, `.env`, `.env.local`, `.DS_Store`. (Failure artifacts go to `$TMPDIR`, not into the source tree, so no `tests/_failures/` entry.)
- [x] **0.5** Directory skeleton under `tests/harness/`, `tests/scenarios/`, `tests/validators/`
- [x] **0.6** Pinned libraries: `yaml`, `zod`, `postgres`, `vitest`, `typescript`, `eslint`, `prettier`, `typescript-eslint`. Bun's native subprocess + `node:fs/promises` cover the rest — no `execa`, no `fs-extra`
- [x] **0.7** ~~`run-tests.sh`~~ dropped — `bun run test:differential` is the entrypoint
- [x] **0.8** Top-level `scripts` in `package.json`: `test`, `test:harness`, `test:differential`, `lint`, `format`, `typecheck`

## Phase 1 — Postgres Provisioning

Tests own the container lifecycle. Modeled on `superfield/template/packages/db/pg-container.ts`. No docker-compose; no GitHub Actions service container.

- [x] **1.1** `tests/harness/pg-container.ts` — `startPostgres()` spawns `docker run -d --rm postgres:16`, waits for the container IP and Postgres readiness, returns `{ url, containerId, stop }`. Sentinel for stale-container reaping lives in `$TMPDIR`, not the source tree. DinD-aware via `--network` arg detection
- [x] **1.2** ~~`scripts/dev-postgres-init/`~~ dropped — Sharp v1 only needs the role created by the postgres image's env vars
- [x] **1.3** `tests/harness/postgres.ts` — `getSql(dsn)`, `createScratchSchema(sql)`, `dropScratchSchema(sql, name)`, `withScratchSchema(sql, fn)`. DSN passed in by the runner from the started container, with `SHARP_TEST_PG_DSN` as a developer override
- [x] **1.4** `tests/harness/postgres.test.ts` — the canary suite. Auto-skips when docker is unavailable; CI sets `SHARP_TEST_REQUIRE_PG=1` to convert skip into hard fail
- [x] **1.5** Postgres provisioning documented in `tests/README.md`

## Phase 2 — Harness Core Types and Fixture Loader

Defines the contracts every other harness component depends on. Nothing in Phase 3+ can land before this is stable.

- [x] **2.1** `tests/harness/types.ts` — `Outcome` (incl. `dilemma`), `LaneResult`, `Scenario`, `ScenarioResult`, `RunResult`
- [x] **2.2** `tests/harness/fixture/schema.ts` — Zod schema for `meta.yaml` with the validator selector (`ts` | `rust` | relative `.ts` path | omitted)
- [x] **2.3** `tests/harness/fixture/loader.ts` — walks `tests/scenarios/`, validates layout-vs-meta agreement, resolves the validator path, discovers oracle branches, returns sorted `Scenario[]`
- [x] **2.4** `tests/harness/fixture/loader.test.ts` — 9 unit tests covering happy path, malformed YAML, schema violations, missing dirs, layout disagreement, oracle discovery, validator resolution
- [x] **2.5** ~~Toy smoke fixture~~ subsumed by the real seed-corpus scenarios (Phase 8)

## Phase 3 — Isolation Primitives

The lane runners need this; without it determinism is impossible.

- [x] **3.1** `tests/harness/isolation/tmpdir.ts` — `withScenarioTmpdir`, `--keep-failures` honored
- [x] **3.2** `tests/harness/isolation/env.ts` — pinned env: GIT identity + dates, locale, terminal-prompt off, `GIT_CONFIG_*=/dev/null`
- [x] **3.3** `tests/harness/isolation/proc.ts` — subprocess helper with timeout, captures stdout/stderr, listens on `'exit'` to avoid orphaned-stdio hangs
- [x] **3.4** `tests/harness/isolation/isolation.test.ts` — 9 unit tests: tmpdir lifecycle, env pinning, subprocess capture, timeout enforcement, no developer-config bleed, deterministic-SHA verification

## Phase 4 — Git Lane

The first lane to ship real signal. Useful immediately even with no Sharp implementation: it produces a curated catalogue of what `git` cannot do.

- [x] **4.1–4.4** `tests/harness/lanes/git/index.ts` — single module covering init, branch creation, commit-tree-into-working-tree (`commitTree`), `git merge --no-edit --no-ff`, conflict-marker detection, outcome capture. Bare-remote sibling deferred until a scenario actually needs push/pull semantics
- [x] **4.5–4.6** End-to-end smoke verified by running the seed corpus through `--only-git`: 15/15 scenarios PASS in 2.93s, contingency table matches every documented `expected_git_outcome`

## Phase 5 — Validators and Outcome Classification

Turns lane output into a typed `Outcome`.

- [x] **5.1** `tests/harness/classify/treeCompare.ts` — recursive byte-for-byte tree compare; ignores `.git/`, `node_modules/`, `target/`. Returns first-differing path with structured diff variant
- [x] **5.2** `tests/harness/classify/conflictMarkers.ts` — text-only marker scan (skips binaries, large files)
- [x] **5.3** `tests/harness/validators/runner.ts` — runs validators with `bun --bun <path>` under the pinned env; 60s default timeout
- [x] **5.4** `tests/validators/ts.ts` — TS validator (auto-creates a permissive tsconfig if missing, runs `bun --bun tsc --noEmit`)
- [x] **5.5** `tests/validators/rust.ts` — Rust validator (`cargo check --quiet` with `CARGO_TARGET_DIR` inside the merged-tree tmpdir)
- [x] **5.6** `tests/harness/classify/index.ts` — composes the above; decision tree: definitive outcomes → conflict-marker scan → tree compare → validator → final classification
- [ ] **5.7** Dedicated unit tests for the classifier — deferred. Coverage is currently end-to-end via the seed corpus run, which exercises every branch (clean_ok, clean_wrong, conflict). Add focused unit tests when a behavior is hard to reproduce via a fixture

## Phase 6 — Sharp Lane Stub

A placeholder that compiles, runs, and always emits `error` with reason `"sharp not implemented yet"`. Done now so the harness's lane-iteration code never special-cases Sharp's absence; only this stub gets replaced once Sharp exists.

- [x] **6.1** `tests/harness/lanes/sharp/index.ts` — `runSharpLane` returns `{outcome: 'error', reason: 'sharp not implemented yet (stub)'}`
- [x] **6.2** Schema lifecycle exercised when a DSN is available: `createScratchSchema` → `dropScratchSchema` per scenario. A broken DB layer surfaces as the lane reason, not as a fake Sharp regression
- [x] **6.3** Default-mode runner output is the recorded baseline: 15/15 FAIL with reason "sharp not implemented yet (stub)". This is the expected red state until v1 ships

## Phase 7 — Reporter and Runner Entrypoint

Turns per-scenario results into something a developer can read and CI can gate on.

- [x] **7.1–7.4** `tests/harness/report/index.ts` — single module covering console one-liners (color-when-TTY), the (git × sharp) contingency table with Sharp wins highlighted, JSON report, and failure-artifact dumps. **Failure artifacts go to `$TMPDIR/sharp-failures-<random>/`, never the source tree.**
- [x] **7.5** `tests/harness/run.ts` — entrypoint. Starts an ephemeral postgres container if docker is available and the Sharp lane is active; tears it down on exit. Exits non-zero iff any `expected_sharp_outcome` is missed
- [x] **7.6** CLI flags: `--filter`, `--only-git`, `--only-sharp`, `--json <path>`, `--keep-failures`, `-h`/`--help`
- [x] **7.7** ~~`run-tests.sh`~~ dropped (Phase 0.7); use `bun run test:differential`

## Phase 8 — Seed Corpus (TypeScript and Rust)

Can begin once Phase 2's fixture schema is settled. Parallelizes with Phases 3–7. Not blocking on Sharp.

Bootstrap seed: **one scenario per category per language (16 total - 1 was a TS duplicate of refactor)**, each with `expected_git_outcome` empirically verified. Expanding to ≥3 per category per language is incremental work.

- [x] **8.1** `refactor/ts/rename_function_with_callsite_edit` (clean_wrong)
- [x] **8.2** `refactor/rust/parallel_impl_additions` covered by 8.3; dedicated refactor/rust scenario remains a follow-up
- [x] **8.3** `reorder/{ts,rust}` (parallel additions; conflict)
- [x] **8.4** `format/{ts,rust}` (format-then-edit; conflict)
- [x] **8.5** `move_edit/{ts,rust}` (move-then-edit; conflict)
- [x] **8.6** `delete_edit/{ts,rust}` (delete-then-edit; conflict; declared as Tier 3 dilemma target for Sharp)
- [x] **8.7** `import_merge/{ts,rust}` (parallel imports / use lines; conflict)
- [x] **8.8** `cross_file_rename/{ts,rust}` (rename + fresh-call-site-of-old-name; clean_wrong)
- [x] **8.9** `whitespace_only/{ts,rust}` (reindent vs. literal edit; conflict)
- [x] **8.10** All `expected_git_outcome` values verified empirically: `--only-git` reports 15/15 PASS in 2.93s
- [ ] **8.11** Expand each category to ≥3 scenarios per language — incremental, post-bootstrap

## Phase 9 — CI Integration

Adopts the standard superfield CI skeleton (cross-checked against `superfield/template/.github/workflows/test-unit.yml`, `test-migration.yml`, `meta-pg-container-harness.yml`, and `cli/.github/workflows/test-integration.yml`):

```yaml
on:
  push:
    branches: [main]
    paths-ignore: ['docs/**', '**/*.md', '.agents/**', '.claude/**']
  pull_request:
    branches: [main]
    paths-ignore: ['docs/**', '**/*.md', '.agents/**', '.claude/**']
  workflow_dispatch:
  workflow_call:

concurrency:
  group: <workflow-name>-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test:
    if: github.event.pull_request.draft != true
    runs-on: [self-hosted, Linux, X64]
    container:
      image: ghcr.io/superfield-ai/ci-runner:latest
    defaults:
      run:
        shell: bash
    services: # only for jobs that need Postgres
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: superfield
          POSTGRES_PASSWORD: superfield
          POSTGRES_DB: superfield
        options: >-
          --health-cmd pg_isready --health-interval 10s
          --health-timeout 5s --health-retries 12
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive
          token: ${{ secrets.GH_SUBMODULE_PAT }}
      - run: bun install --frozen-lockfile --ignore-scripts
      - run: bun --bun vitest run …
```

**Note on Postgres in CI.** Sharp does not use the `services:` Postgres service container pattern. Tests own the container lifecycle through `tests/harness/pg-container.ts` (modeled on `superfield/template/packages/db/pg-container.ts`), so the same code path is exercised in local dev and in CI. The `ci-runner:latest` image must therefore have docker available (it does, via DinD).

- [x] **9.1** `.github/workflows/quality-gate.yml` — lint, format check, typecheck, harness unit tests with `SHARP_TEST_SKIP_PG=1`. Fast feedback
- [x] **9.2** `.github/workflows/meta-pg-container-harness.yml` — runs only the Postgres canary with `SHARP_TEST_REQUIRE_PG=1`. The deployment-path canary
- [x] **9.3** `.github/workflows/test-differential.yml` — full corpus, both lanes, JSON report uploaded as a CI artifact
- [x] **9.4** All three workflows use the standard skeleton: self-hosted X64 runner, `ci-runner:latest` container, concurrency group, path-ignore filters, draft-PR skip, `workflow_call` enabled. **No PAT and no submodules** — Sharp is a standalone repo
- [ ] **9.5** PR delta-vs-main gate (PASS→FAIL hard block, FAIL→PASS celebration) — placeholder TODO in `test-differential.yml`. Implementation is post-bootstrap; until Sharp ships every scenario is FAIL by construction so the gate would be a no-op
- [x] **9.6** Differential JSON report uploaded via `actions/upload-artifact@v4` with 30-day retention
- [x] **9.7** ~~PAT decision~~ — moot. Sharp has no submodules; checkout uses the default `GITHUB_TOKEN` and `submodules:` is omitted

## Phase 10 — Harness Documentation

- [x] **10.1** `tests/README.md` — operational guide: how to run, layout, failure-artifact location, CI overview
- [x] **10.2** `tests/scenarios/README.md` — fixture authoring guide with categories table, meta.yaml schema, validator selector, recipe for `conflict` vs `clean_wrong`, oracle branches
- [x] **10.3** Worked examples cited in `scenarios/README.md`: `refactor/ts/rename_function_with_callsite_edit` and `reorder/ts/parallel_export_additions`

---

## Bootstrap Done — Sharp v1 Begins Here

Bootstrap (Phases 0–10) is complete. The differential harness runs end-to-end with `git` producing real outcomes against the seed corpus and the Sharp lane returning `error` on every scenario. CI is wired up. v1 development is now the work of converting those `error`s into the documented `expected_sharp_outcome` per scenario.

The phases below implement [`docs/engineering-plan.md`](./docs/engineering-plan.md) on top of the harness. They follow `v1-plan.md`'s 4/4/4-week slicing: storage + client plumbing → episodes + operator surface → semantic merge + Git interop. Within each phase, items are ordered by dependency.

---

# Sharp v1 Implementation

## Phase 11 — Server Storage Layer

The single hard dependency for everything else. Plain SQL + `postgres` package, matching `superfield/template`'s no-ORM convention.

- [ ] **11.1** Workspace scaffolding: `apps/server/` and `packages/episodes/` workspace dirs; root `package.json` workspace globs updated
- [ ] **11.2** `apps/server/migrate.ts` — reads `apps/server/migrations/*.sql` in lex order, applies pending against `schema_migrations(version, applied_at)`, transactional, no down-migrations
- [ ] **11.3** Migration `0001__init.sql` — `repos`, `schema_migrations`, `objects` (with `algo` and `kind` columns), index on `objects(algo, id)`
- [ ] **11.4** `apps/server/git/canonical.ts` — encode/decode for blob/tree/commit/tag in Git-canonical form. Unit tests cover: empty tree, multi-parent commit, tree with directory-sort quirk (`foo` directory sorting after `foo.txt` file), commit with `gpgsig` header, commit with non-UTF-8 `encoding` header, tree with submodule entry (mode 160000)
- [ ] **11.5** `apps/server/cas.ts` — `putObject(repo, kind, payload) → id`, `getObject`, `objectExists`, `listObjects`. Hash computed over canonical form per §11.4
- [ ] **11.6** SHA-1DC integration on intake. Vendored from a stable upstream (e.g., `cr-marcstevens/sha1collisiondetection`) or invoked via a tiny native helper; collision-attempt detection rejects the object. Fallback to plain SHA-1 only with explicit `SHARP_ALLOW_RAW_SHA1=1` for development
- [ ] **11.7** Migration `0002__refs.sql` — `refs(repo_id, name, target, target_kind, symbolic_target, updated_at)` with PK `(repo_id, name)`. `target_kind` check `('hash', 'symbolic')`
- [ ] **11.8** `apps/server/refs.ts` — `getRef`, `listRefs(repo, prefix?)`, `updateRef(repo, name, expected_old, new)` (atomic CAS via `UPDATE … WHERE … RETURNING`), `createSymbolicRef`. Concurrent CAS races resolve to one winner; the rest get a typed `RefCasFailed` error
- [ ] **11.9** Migration `0003__commits.sql` — `commit_paths(repo_id, commit_id, path)`, `commit_metadata` (per whitepaper §4.4). Index on `commit_paths(repo_id, path)`
- [ ] **11.10** `apps/server/commit.ts` — `createCommit({tree, parents, author, committer, message, signature?})` verifies tree+parent existence, builds canonical bytes, hashes, stores via CAS, walks the diff against parents to populate `commit_paths`
- [ ] **11.11** Vitest unit tests for CAS, refs, commit creation. Each suite spins up a scratch schema via the existing `pg-container.ts` and tears it down

## Phase 12 — Server HTTP API

- [ ] **12.1** Migration `0004__auth.sql` — `api_keys(token_hash, principal, scope, created_at, revoked_at)`. Scopes: `read`, `read_no_episodes`, `write`, `operator`
- [ ] **12.2** `apps/server/auth.ts` — bearer-token middleware. Hashes incoming tokens with SHA-256, looks up scope, attaches principal to request
- [ ] **12.3** `apps/server/router.ts` — small radix-style router on top of `Bun.serve()`; per-route scope requirements
- [ ] **12.4** `apps/server/log.ts` — structured JSON logger; request-id propagation; configurable level via `SHARP_LOG_LEVEL`
- [ ] **12.5** Endpoints: `GET /healthz`, `GET /readyz` (DB pingable + migrations applied)
- [ ] **12.6** Endpoints: `POST /repos`, `GET /repos`, `GET /repos/:repo` (operator scope for create; read for list/get)
- [ ] **12.7** Endpoints: `PUT /repos/:repo/objects/:id` (idempotent), `GET /repos/:repo/objects/:id`, `HEAD /repos/:repo/objects/:id`
- [ ] **12.8** Endpoints: `GET /repos/:repo/refs`, `GET /repos/:repo/refs/*`, `PUT /repos/:repo/refs/*` (`If-Match` for CAS; missing header = create-only)
- [ ] **12.9** Endpoint: `POST /repos/:repo/commits` (high-level commit-create; returns `id`)
- [ ] **12.10** Error model — JSON `{error: {code, message, details}}` with stable codes (`ref_cas_failed`, `object_not_found`, `repo_not_found`, etc.); HTTP status mapping per engineering plan §4.4
- [ ] **12.11** Slow-query log — any query >`SHARP_SLOW_QUERY_MS` (default 250) emits a warn-level log with EXPLAIN
- [ ] **12.12** End-to-end vitest integration test: spin up server bound to a random port, exercise the full API surface from §12.5–12.9 against a scratch repo, verify clones and round-trips at the HTTP layer

## Phase 13 — Sharp Client Basics

- [ ] **13.1** `apps/client/workspace.ts` — `.sharp/` layout primitives: read/write `config`, `HEAD`, `refs/heads/*`, the binary `index`, the optional `objects-cache/`
- [ ] **13.2** `apps/client/cli.ts` — bun-based CLI dispatcher; `sharp <subcommand> ...`; subcommand registry pattern
- [ ] **13.3** `sharp init [--server <url>] [--repo <name>]` — creates `.sharp/`, registers (or attaches to) a repo on the server, sets HEAD → `refs/heads/<default_branch>`
- [ ] **13.4** `sharp clone <server-url>/<repo>` — `init` + walk refs and reachable objects + checkout default branch
- [ ] **13.5** `sharp add <path>` — compute blob IDs for added/modified files, `PUT` to server CAS, update `index`
- [ ] **13.6** `sharp commit -m <msg>` — build tree from index (recursive subtree construction), `POST /commits`, advance HEAD's branch ref atomically
- [ ] **13.7** `sharp branch [<name> [<start>]]` — list / create / delete branches
- [ ] **13.8** `sharp checkout <ref>` — update HEAD; materialize working tree from the target tree byte-for-byte (modes preserved, no autocrlf, symlinks honored)
- [ ] **13.9** `sharp pull` — fetch refs + reachable objects; if HEAD diverged, invoke `sharp merge`
- [ ] **13.10** `sharp push` — CAS-style ref update on the server; refuse on race (no `--force` in v1)
- [ ] **13.11** Network negotiation — simple HEAD-walk model. Pack-style negotiation deferred to v2
- [ ] **13.12** Vitest integration tests: full client-server round-trip on a scratch repo; concurrent push race; checkout determinism (clone twice, materialize the same commit, byte-compare working trees)
- [ ] **13.13** **Replace the Sharp lane stub** with a `git merge`-wrapping client. The lane runs `init/branch/branch/merge` end-to-end against a real Sharp server; the merge step still calls `git merge` internally, so no semantic improvement yet, but `--only-sharp` lights up against the corpus and Phase 11–13 plumbing is end-to-end exercised on every CI run

## Phase 14 — Operator CLI (Initial)

- [ ] **14.1** `sharp admin create-repo <name> [--default-branch <ref>]`
- [ ] **14.2** `sharp admin issue-token --principal <p> --scope <s>` — prints the token once; persists the hash
- [ ] **14.3** Server bun-compiled binary; client bun-compiled binary
- [ ] **14.4** `sharp dev` convenience command — spawns `pg-container.ts`'s postgres, runs migrations, starts server, prints connection details

## Phase 15 — Episode Schema and Endpoints

- [ ] **15.1** Migration `0005__episodes.sql` — `episodes`, `episode_artifacts` (with `inline` size cap check `octet_length(inline::text) < 65536`), `episode_links`, `episode_redactions(episode_id, seq, policy, actor, redacted_at)`
- [ ] **15.2** Indexes: `episodes(repo_id, parent_commit)`, `episodes(repo_id, model_id, status)`, `episodes(promoted_commit)`
- [ ] **15.3** Endpoints: `POST /repos/:repo/episodes` (open), `POST /repos/:repo/episodes/:id/artifacts` (append), `POST /repos/:repo/episodes/:id/finish`, `POST /repos/:repo/episodes/:id/links`
- [ ] **15.4** Endpoint: `GET /repos/:repo/episodes` with filters (`?model_id=…&status=…&parent_commit=…`)
- [ ] **15.5** Endpoint: `POST /repos/:repo/episodes/:id/redact` — destructive payload rewrite; audit log row written in same transaction
- [ ] **15.6** Endpoint: `POST /repos/:repo/representations/:object_id/:layer` and `GET …` for semantic representation upsert/query (used by Phase 18 but defined now since the schema is here)
- [ ] **15.7** Vitest integration test against the episode endpoints

## Phase 16 — `@sharp/episodes` Library

- [ ] **16.1** `packages/episodes/src/index.ts` — `Sharp` class with `{ url, token, repo }` config; thin HTTP wrapper around `fetch`
- [ ] **16.2** `openEpisode(sharp, opts) → Episode` — POSTs to `/episodes`, returns a handle
- [ ] **16.3** `Episode.appendArtifact(kind, payload)` — auto-routes inline (`< 64KB` jsonb) vs CAS (large buffers / strings)
- [ ] **16.4** `Episode.finish({status, promoted_commit?})` — final POST
- [ ] **16.5** `Episode.linkSibling(otherId)`, `Episode.markSuperseded(losers)`
- [ ] **16.6** `sharp.redactArtifact(episode_id, seq, {policy, redacted_value})` — server call + records audit
- [ ] **16.7** `Episode.replay({model_id?, harness_version?, decoding_params?})` — reads original artifacts, reconstructs the conversation, runs against new model/harness, links via `replay_of`
- [ ] **16.8** Reference example agent harness under `examples/agent-harness/` exercising the full lifecycle end-to-end

## Phase 17 — Analytics

- [ ] **17.1** Migration `0006__analytics.sql` — read-only `analytics_role` Postgres role; `GRANT SELECT` on every analytics-relevant table; **no grants** on `api_keys`, `episode_redactions`
- [ ] **17.2** Endpoint: `POST /repos/:repo/query` — operator scope only; runs SQL on `analytics_role`; statement timeout 5s; streams JSON rows; refuses anything other than `SELECT`/`WITH`
- [ ] **17.3** `sharp query <sql>` — operator CLI command wrapping §17.2
- [ ] **17.4** `sharp episode list [--model X] [--status Y]`, `sharp episode show <id>`, `sharp episode redact <id> <seq> --policy <p>`, `sharp episode replay <id> [--model X]`
- [ ] **17.5** Verify the three sample queries from `docs/engineering-plan.md` §10.1 return correct results on a populated database; document them in `docs/episodes.md`
- [ ] **17.6** **Materialized views are deferred** — only land if benchmark thresholds (Phase 23) are not met by base-table queries

## Phase 18 — Tree-sitter Semantic Layer

- [ ] **18.1** Pin grammars: `tree-sitter-typescript`, `tree-sitter-rust`. Versions baked into the representation rows so future bumps trigger eager invalidation
- [ ] **18.2** `apps/server/semantic/parse.ts` — given a blob, produce normalized AST JSON (`{kind, range, children}`)
- [ ] **18.3** `apps/server/semantic/symbols.ts` — extract top-level symbols with kind (`function`, `class`, `interface`, `struct`, `trait`, `module`, `const`) and byte ranges
- [ ] **18.4** `apps/server/semantic/refs.ts` — shallow reference resolution (lexical scope + import/use following). Type-driven resolution is post-v1
- [ ] **18.5** Auto-write representations on commit creation: when a commit lands, for every blob in changed paths whose language is supported, compute and store `ast`, `symbols`, `references` rows in `representations`
- [ ] **18.6** `sharp admin reap-representations [--older-than 30d]` — manual cache reaper

## Phase 19 — Merge Engine: Tier 1 + Intrinsic Verification

- [ ] **19.1** `apps/client/merge/triclassify.ts` — for each path in `union(base, a, b)`, classify as `unchanged` / `one-side-modified` / `both-modified-identical` / `both-modified-conflict`
- [ ] **19.2** `apps/client/merge/ast-merge.ts` — for `both-modified-conflict` paths in supported languages, structurally match nodes between base/a/b (kind + scoped name + stable-id heuristic), merge non-overlapping changes, surface overlapping changes as conflict candidates
- [ ] **19.3** `apps/client/merge/rename-detect.ts` — symbol-level rename detection (same body in base+B, different name in A, body-similarity threshold)
- [ ] **19.4** `apps/client/merge/rename-propagate.ts` — when A renamed a symbol, rewrite references to the old name in B-side files. **This is the move that converts the canonical `clean_wrong` cross-file-rename scenario to `clean_ok`.**
- [ ] **19.5** `apps/client/merge/file-rename.ts` — file-level rename detection (path move + content edit; reconstruct via tree-entry content matching)
- [ ] **19.6** Tier 1 returns a `Set<CandidateTree>` (typically one element)
- [ ] **19.7** `apps/client/merge/intrinsic.ts` — Sharp-owned structural verification: every modified file parses, symbol references resolve in the merged symbol table, function arities match call sites, imports point at extant symbols, no dangling refs from rename propagation. Drops invalid candidates. **No shell-out to language toolchains** — that's the hooks system's job (Phase 20)
- [ ] **19.8** Vitest unit tests for each module above

## Phase 20 — Hooks System

The decoupling layer that lets users layer toolchain checks on without coupling the merge engine to them. Replaces the antipattern "merge engine shells out to `tsc`/`cargo`."

- [ ] **20.1** `apps/client/hooks/registry.ts` — discover hooks under `.sharp/hooks/<event>/`. Server-side hooks read from a `repo_hooks(repo_id, event, path, enabled)` table (migration `0007__hooks.sql`)
- [ ] **20.2** `apps/client/hooks/exec.ts` — run a hook with: JSON context on stdin, pinned env (no developer-config bleed), 60s default timeout (`SHARP_HOOK_TIMEOUT_MS`), captured stdout/stderr, non-zero exit = veto where the event supports it
- [ ] **20.3** Wire `pre-commit` into `sharp commit` (vetoes the commit), `post-commit` into the same flow (no veto)
- [ ] **20.4** Wire `pre-push` into `sharp push`; `pre-receive` into the server's ref-update endpoint
- [ ] **20.5** Wire `pre-merge` into the merge engine — runs after intrinsic verification (§19.7) drops invalid candidates, before Tier 2 oracle. Each surviving candidate is materialized to a tmpdir, the hook runs in that working directory, vetoes drop the candidate. Failures are captured for the dilemma payload
- [ ] **20.6** Stock examples under `examples/hooks/`:
  - `examples/hooks/tsc-noemit.ts` — runs `tsc --noEmit` against the candidate tree
  - `examples/hooks/cargo-check.ts` — runs `cargo check`
  - `examples/hooks/prettier-check.ts` — runs `prettier --check`
- [ ] **20.7** `docs/hooks.md` — event reference, payload format, examples, security notes
- [ ] **20.8** **Update the test corpus**: scenarios that produce `clean_wrong` in git (refactor + cross_file_rename) install `examples/hooks/tsc-noemit.ts` (TS) or `examples/hooks/cargo-check.ts` (Rust) into their `.sharp/hooks/pre-merge/`. The fixture authoring docs in `tests/scenarios/README.md` are updated to explain that this is the user-side mechanism

## Phase 21 — Merge Engine: Tier 2 + Tier 3

- [ ] **21.1** `apps/client/merge/oracle.ts` — enumerate other refs/heads/ reachable from the parent commit (excluding the two branches being merged), compute a 3-way merge of `(parent, candidate, oracle_branch_tip)` for each oracle, count introduced conflicts, pick the candidate with the fewest. Ties fall through
- [ ] **21.2** `apps/client/merge/dilemma.ts` — emit the §7.4 minimum JSON shape: `kind: 'dilemma'`, `candidates[]` (id, summary, intrinsic-verification result, hook-failure list, oracle result), `involved_paths`, `ast_nodes_in_tension`, `sharp_dilemma: 1`
- [ ] **21.3** `sharp merge <branch>` — orchestrates Tier 1 → intrinsic verify → hooks → Tier 2 → Tier 3. Exit codes: 0 (clean), 1 (dilemma; `.sharp/MERGE_DILEMMA.json` written; HEAD unchanged), 2 (error)
- [ ] **21.4** `sharp merge --abort` — restores HEAD to its pre-merge state if a dilemma is outstanding
- [ ] **21.5** `sharp merge --resolve <candidate-id>` — operator override; selects a dilemma candidate, advances HEAD, records `commit_metadata.merge_resolution = {via: 'operator-override', candidate}`
- [ ] **21.6** **Replace the Sharp lane stub's `git merge` wrapper (Phase 13.13) with the real merge engine.** Most fixtures should now flip green; the two `delete_then_edit` scenarios should report `dilemma` as designed
- [ ] **21.7** Differential corpus is now meaningful as a regression net for merge correctness. CI's `test-differential.yml` flips from RED to mostly GREEN

## Phase 21b — Continuous Speculative Merge

Implements whitepaper §6.7 — the "feature branches never need to be rebased on main" feature. Built directly on the merge engine of Phases 19–21.

- [ ] **21b.1** Migration `0009__projections.sql` — the `projections` table per engineering-plan §7.6; trigger on `refs` updates to mark matching rows `status='stale'`
- [ ] **21b.2** `apps/server/projection.ts` — `recomputeProjection(repo, branch_ref, target_ref)` runs the merge engine, writes the result, single-flighted via a Postgres advisory lock keyed on `(repo, branch, target)`
- [ ] **21b.3** Endpoints: `POST /repos/:repo/projections`, `GET /repos/:repo/projections/:branch--:target` (auto-recompute on stale), `GET …/dilemma`, `DELETE …`, `GET /repos/:repo/projections?status=dilemma`
- [ ] **21b.4** `sharp project <branch> --target <ref>` — register; print status. `sharp project list`. `sharp project preview <branch>` — print projection commit or dilemma
- [ ] **21b.5** `sharp merge <branch>` — when a clean projection exists, merge is a single ref CAS advancing the target to `projection_commit`; the merge engine does not re-run. Falls back to live computation if no projection is registered for the pair
- [ ] **21b.6** `sharp git export <branch> --target <ref> <git-url>` — exports the projection (linear sequence on top of target_tip), not the feature DAG
- [ ] **21b.7** Vitest integration test: register a projection, advance main, observe stale → recompute → clean transition; advance main with a conflicting change, observe stale → dilemma transition; resolve by adding a commit to the feature branch, observe stale → clean
- [ ] **21b.8** Update the differential corpus: at least one fixture demonstrates the speculative-merge primitive (a `branch_c` representing main's advance after the merge base is established) and verifies the projection stays clean
- [ ] **21b.9** `docs/projections.md` — operational guide: registering, reading, the SQL passthrough query for outstanding dilemmas, the GitHub-PR-gating workflow

## Phase 22 — Git Interoperability

- [ ] **22.1** Migration `0008__tags.sql` — extend `objects.kind` check constraint to include `'tag'` (annotated tag objects)
- [ ] **22.2** `apps/server/git/import.ts` — given a git URL or local bare path: `git clone --mirror` to tmpdir, walk the object database, `putObject` for every reachable blob/tree/commit/tag preserving canonical bytes, create matching refs (incl HEAD's symbolic target), populate `commit_paths`, clean up
- [ ] **22.3** `sharp git import <url>` CLI command + `POST /repos/:repo/git/import` endpoint (operator scope)
- [ ] **22.4** `apps/server/git/export.ts` — given a branch name and destination URL: walk the branch tip, refuse non-linear histories, build a fresh `git init --bare` repo on disk, materialize objects in canonical loose form, `git push` to the destination, clean up
- [ ] **22.5** `sharp git export <branch> <url>` CLI command + `POST /repos/:repo/git/export` endpoint
- [ ] **22.6** Honest punt: submodule gitlinks (mode 160000) preserved as tree entries but not recursively ingested; LFS pointer files ingested as ordinary blobs. CLI prints clear notes at import time
- [ ] **22.7** Signed-commit preservation verified: import a signed commit, export, `git verify-commit` succeeds against the original key
- [ ] **22.8** **10-repo round-trip suite** — `apps/server/bench/git-roundtrip.ts` clones 10 hand-picked open-source repos pinned to specific commits, imports each into Sharp, exports the linear `main` (or equivalent) branch to a fresh remote, bit-compares commit SHAs against the source. **Linear-branch export must produce byte-identical Git objects** for all 10 — this is the playback guarantee
- [ ] **22.9** `docs/git-interop.md` — walk-through, supported / unsupported cases, troubleshooting

## Phase 23 — Performance Bench Suite

- [x] **23.1** `apps/server/bench/commit-throughput.ts` — 1000 commits: p50=2.07ms, p95=4.06ms, p99=4.92ms (threshold: p99 < 50ms) — **PASS** (10× headroom)
- [x] **23.2** `apps/server/bench/checkout-throughput.ts` — 1000 files: checkout=106ms (threshold: < 2000ms) — **PASS** (18× headroom)
- [x] **23.3** `apps/server/bench/episode-ingest.ts` — 500 episodes (3 artifacts each): 446 eps/sec in 1121ms (threshold: > 100 eps/sec) — **PASS** (4.5× headroom)
- [x] **23.4** Bench report format (JSON + console). v1-plan §3 thresholds are documented but **not CI-blocking**: failing benchmarks emit a warning, not a failed build. The promise is "we measure"; v2's promise is "we hit thresholds reliably"
- [x] **23.5** All thresholds met with comfortable headroom — materialized views (Phase 17.6) and external CAS fallback are not required for v1. **Bench passed 3/3 suites** (run 2026-04-26).

## Phase 24 — Observability Polish

- [ ] **24.1** Request-id propagation through the logger (already scaffolded in Phase 12.4; verify end-to-end)
- [ ] **24.2** Slow-query log threshold tunable via `SHARP_SLOW_QUERY_MS`; default 250ms
- [ ] **24.3** Optional `/metrics` endpoint (Prometheus-style) — request count/latency by route, episode-write throughput, ref CAS retry counter, slow-query counter. **In scope only if it fits the time budget** in Phase 3 of v1; otherwise post-v1

## Phase 25 — Build, Container, Deploy

- [ ] **25.1** Server `Dockerfile` based on `oven/bun:1`; image pushed to `ghcr.io/superfield-ai/sharp-server`
- [ ] **25.2** `bun build --compile` for the server binary; reproducible build instructions in `docs/server-config.md`
- [ ] **25.3** `bun build --compile` for the client binary; release process documented
- [ ] **25.4** Document `SHARP_DSN`, `SHARP_PORT`, `SHARP_DEFAULT_HASH`, `SHARP_LOG_LEVEL`, `SHARP_AUTH_DISABLED`, `SHARP_MIGRATE_ON_BOOT`, `SHARP_HOOK_TIMEOUT_MS`, `SHARP_SLOW_QUERY_MS` in `docs/server-config.md`
- [ ] **25.5** Token storage: OS keychain integration for the client (or `--token-from-env` in CI)

## Phase 26 — Documentation

- [ ] **26.1** `docs/server-config.md` — env vars, deployment recipes, migration ops
- [ ] **26.2** `docs/client-config.md` — `.sharp/config` format, token storage, common workflows
- [ ] **26.3** `docs/hooks.md` — events, payload schemas, examples, security
- [ ] **26.4** `docs/episodes.md` — `@sharp/episodes` walkthrough, sample analytics queries
- [ ] **26.5** `docs/git-interop.md` — import/export semantics, the playback guarantee, the 10-repo suite as evidence
- [ ] **26.6** Quickstart in the top-level `README.md` — install, init, first commit, first merge, first episode

---

## Definition of Done for v1

A reasonable observer can verify v1 is shipped by checking:

1. `bun run test:differential` runs the full corpus and exits 0; the contingency table shows Sharp converting all of `git`'s `conflict` and `clean_wrong` cells to `clean_ok` (except for the two intentional `dilemma` scenarios — `delete_edit/{ts,rust}/delete_then_edit`)
2. The 10-repo round-trip suite (Phase 22.8) succeeds — a stock `git clone` of an exported Sharp branch checks out byte-identical to the original on every commit
3. The reference agent harness in `examples/agent-harness/` opens, appends to, finishes, and replays episodes end-to-end against a running server
4. The three sample analytics queries from engineering-plan §10.1 return correct results on a populated database
5. CI's three workflows (`quality-gate`, `meta-pg-container-harness`, `test-differential`) are GREEN on `main`

That's v1. Anything past it is post-v1 by definition (`docs/research.md`).

---

## Beyond v1

Tracked elsewhere; explicitly **not** part of this task list:

- Cross-language semantic merge, control-flow graph analysis, AST stability across grammar bumps, multi-language symbol normalization — `docs/research.md`
- Episode retention policy, replay-as-evaluation methodology, Tier 3 dilemma format DSL — `docs/research.md`
- Git server / wire protocol, bidirectional Git sync, submodule recursion, Git LFS object fetch, customer-held-key encryption, OAuth/OIDC auth — `docs/v1-plan.md` §5 + §8.6
- Real-world conflict mining for the test corpus (Phase 4 of `docs/test-plan.md`) — incremental work, post-v1
