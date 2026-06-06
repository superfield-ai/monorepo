# Sharp Engineering Plan

Concrete plan for implementing Sharp v1. Pairs with the protocol specification in [`whitepaper.md`](./whitepaper.md), the high-level scope in [`v1-plan.md`](./v1-plan.md), the differential test substrate in [`test-plan.md`](./test-plan.md), and the bootstrap status in [`../TASKS.md`](../TASKS.md). Forward-looking research is in [`research.md`](./research.md).

This document is the design-level breakdown of what to build, in what order, and how the pieces fit together. It is not itself an executable task list; a sibling `TASKS-v1.md` will be authored once this plan is approved.

## 1. Goals

The harness in `tests/` defines what "done" looks like: every scenario in the seed corpus must flip from FAIL to PASS by the end of v1. To get there, this plan delivers:

- **Sharp client basics.** A working VCS surface (`init`, `clone`, `add`, `commit`, `branch`, `merge`, `pull`, `push`) operating against a Sharp server, with a working-tree shadow under `.sharp/`.
- **Sharp client merge checks and execution.** The three-tier merge model from whitepaper §6 — deterministic semantic merge using language server APIs (`ts.LanguageService.findRenameLocations()` for TypeScript, rust-analyzer `textDocument/rename` for Rust), intrinsic structural verification via language diagnostic APIs (`getSemanticDiagnostics()` for TypeScript, `cargo check --message-format=json` for Rust), automatic Tier 2 oracle resolution against in-development branches, and structured Tier 3 dilemma escalation. Additional project-specific checks (`tsc --noEmit` with custom tsconfig, linters, custom validators) are layered on through a Git-style **hooks** system that users opt into; the merge engine's intrinsic path uses LS APIs directly.
- **Continuous speculative merge.** Per whitepaper §6.7, every `(feature, target)` pair has an always-current `refs/sharp-merged/...` projection. Feature branches never need to be rebased on `main`; the projection absorbs the merge work continuously, and merge time is a CAS-style ref advance.
- **Sharp server basics.** Postgres-backed content-addressed object store, refs with atomic compare-and-swap, commit creation, episode storage, semantic-representation storage, HTTP API.
- **Sharp server analytics.** SQL-queryable development history. Hot indexes for the queries called out in v1-plan §6 (paths-touched, episode siblings, model success rates). A `sharp query <sql>` operator command that opens a read-only window onto the unified store.
- **Git compatibility.** `sharp git import <url>` ingests an existing Git repository preserving the full DAG and byte-canonical objects; `sharp git export <branch> <url>` emits a fresh Git repository that any stock `git` client can clone, log, and check out — every commit on the exported branch is playable byte-for-byte.
- **Agent episode library.** A TypeScript library agent harnesses use to bracket runs, append artifacts, link siblings, finalize promotions, and replay archived episodes against newer models or harnesses.

This plan does **not** cover anything in [`research.md`](./research.md): cross-language semantic merge, control-flow graph analysis, AST stability across Tree-sitter grammar bumps, episode retention policy, the Tier 3 dilemma format DSL beyond a minimum viable shape, or the replay-as-evaluation methodology.

## 2. Build Order at a Glance

```
                  +-----------------------------------+
                  | Storage Layer (server, §3)        |
                  | schema, CAS, refs, commit creation|
                  +----------------+------------------+
                                   |
              +--------------------+--------------------+
              |                                         |
              v                                         v
+-----------------------+                   +---------------------------+
| Server HTTP API (§4)  |                   | Episode Library (§9)      |
+-----------+-----------+                   +-------------+-------------+
            |                                             |
            v                                             |
+-----------+----------------------+                      |
| Sharp Client Basics (§5)         |<---------------------+
| init/clone/add/commit/branch/...|
+-----------+----------------------+
            |
   +--------+--------+
   |                 |
   v                 v
+--+-------------+ +-+----------------------+
| Semantic Layer | | Git Interop (§8)        |
| LS + fallback  | | import / export         |
| (§6)           | | playback guarantee      |
+--+-------------+ +-+----------------------+
   |
   v
+--+----------------------------+
| Merge Engine (§7)             |
| Tier 1 / intrinsic verify /   |
| Tier 2 oracle / Tier 3 dilemma|
+--+----------------------------+
   |
   v
+--+-----------------------------------+
| Analytics + Operator CLI (§§10–11)   |
| sharp query, episode list/show/redact|
+--------------------------------------+
```

The storage layer is the single hard dependency; everything else hangs off it. Episode library is independent of the merge engine and can land in parallel. Git interop is independent of merge. Analytics piggybacks on the schema once paths-touched indexing is wired up at commit-create time.

## 3. Storage Layer (Server)

### 3.1 Schema and Migrations

Plain SQL migration files under `apps/server/migrations/<seq>__<name>.sql`, applied in order by a small Bun script at server startup. Migrations are recorded in a `schema_migrations(version, applied_at)` table; never re-run, never edited after release. Convention matches `superfield/template`'s raw-SQL approach (no ORM; types come from hand-written interfaces alongside `postgres` package query calls).

The whitepaper schema (§4, §5.1) adds two pieces v1 needs that aren't in the whitepaper:

```sql
-- Required for multi-repo servers; everything else FKs to repo_id.
repos (
  id uuid primary key,
  name text not null unique,
  default_branch text not null default 'main',
  created_at timestamptz not null default now()
);

-- Tracks "what file paths a commit touched" for analytics queries.
-- Populated on commit creation by walking the diff against the parent.
commit_paths (
  repo_id uuid not null,
  commit_id bytea not null,
  path text not null,
  primary key (repo_id, commit_id, path)
);
```

The `commit_paths` table is the analytics primitive that makes `"all episodes that touched file X"` cheap. Episode-side joins are `episode → promoted_commit → commit_paths`.

Indexes that ship with v1:

- `objects(algo, id)` — object lookup by hash. Composite so SHA-1 ↔ SHA-256 mixed repos still get a clean plan.
- `refs(repo_id, name)` — already the PK.
- `commit_paths(repo_id, path)` — the hot analytics index.
- `episodes(repo_id, parent_commit)`, `episodes(repo_id, model_id, status)` — episode query patterns.
- `episode_artifacts(episode_id, seq)` — already the PK.

### 3.2 CAS for Objects

Object IDs are Git's content-addressing hash (SHA-1 by default; SHA-256 when the repo is initialized with `objectformat=sha256`). The hash is computed over Git's canonical form: `<kind> <decimal-size>\0<payload>`. Sharp stores the **inflated payload** in `objects.data`, not Git's zlib-deflated form, so the same row is queryable without decompression. The deflated form is reconstructed on demand for export.

SHA-1DC (collision-detection variant) runs on intake; any collision-attempt-detection failure rejects the object. Implementation: a small native helper invoked over a stdin pipe, or a pure-TS port if one of acceptable performance exists. This is a hard requirement — we don't ship Sharp on raw SHA-1.

The CAS API is intentionally narrow:

- `putObject(repo, kind, payload) → id` — computes hash, inserts on conflict-skip, returns ID.
- `getObject(repo, id) → { kind, payload }` — single point read.
- `objectExists(repo, id) → boolean` — for negotiation during clone/pull.
- `listObjects(repo) → AsyncIterable<{id, kind}>` — for export.

### 3.3 Refs (Atomic CAS)

Refs use a compare-and-swap update model:

```sql
update refs
   set target = $new_target
 where repo_id = $repo and name = $name and target = $expected_old_target
 returning target;
```

Zero-row return → CAS failure. The client retries with the latest value or surfaces a "your push lost a race" error. This is the same model `git update-ref --create-reflog --no-deref OLDOID NEWOID` provides, mapped onto Postgres' transactional update.

Ref creation: insert with `expected_old_target = NULL` semantics handled by `ON CONFLICT DO NOTHING`.

Symbolic refs (HEAD pointing at `refs/heads/<branch>`): refs schema gets a `target_kind text not null check (target_kind in ('hash', 'symbolic'))` column and a nullable `symbolic_target text`. Already noted in `whitepaper.md` Git interop section as required for HEAD round-trip.

### 3.4 Commit Creation

A commit-create operation is more than a row insert; it must:

1. Verify the commit's `tree` and every `parent` already exist as objects in the same repo (reachability check).
2. Compute the commit object's bytes in canonical Git form, hash, store via CAS.
3. Walk the commit-vs-parent diff and populate `commit_paths`. For multi-parent commits, take the union of paths-changed-vs-each-parent.
4. Optionally update one or more refs in the same transaction (the typical client flow is "create commit, advance branch ref" atomically).

`createCommit({repo, tree, parents, author, committer, message, signature?, ref_update?})` is the high-level server API; the underlying steps are exposed as lower-level primitives for `sharp git import` (which needs to insert pre-formed canonical bytes without recomputing them).

### 3.5 Episode Tables

Already specified in whitepaper §5.1. Implementation notes:

- `episodes.tool_versions` and `decoding_params` are jsonb. Indexed via `gin (tool_versions jsonb_path_ops)` so `decoding_params @> '{...}'` queries plan well.
- `episode_artifacts.content_ref` always points into `objects.id` for the same repo. A `kind in ('prompt','context','tool_call','tool_result','intermediate_patch','validation','judge')` check enforced at the schema level.
- `episode_artifacts.inline` is jsonb; payload size cap enforced by a check constraint (`octet_length(inline::text) < 64 * 1024`) so callers can't accidentally inline a megabyte. Above the cap → must use `content_ref`.

### 3.6 Schema Risks

- **Bloat from intermediate-patch artifacts.** Intermediate patches reference CAS objects so they dedupe across episodes, but if a harness produces unique patches per attempt the `objects` table grows linearly with attempts. Mitigated by the `commit_paths` table making "is this patch touching files we care about" a queryable filter for retention policies (post-v1).
- **`commit_paths` write amplification.** A monorepo commit touching 10k files writes 10k rows. Postgres handles this fine in a single transaction; the cost is real but bounded. Indexes on (`repo_id, path`) make subsequent queries fast.
- **Ref CAS contention.** Concurrent pushes to the same branch race; one wins, the rest retry. Acceptable; v1 does not need optimistic-stash-and-rebase.

## 4. Server HTTP API

### 4.1 Surface

| Verb + path                                           | Purpose                                                                                                   |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `POST /repos`                                         | Create a repo. Server-admin operation                                                                     |
| `GET  /repos`                                         | List repos                                                                                                |
| `PUT  /repos/:repo/objects/:id`                       | Idempotent object put with `kind` query param; body is the inflated payload                               |
| `GET  /repos/:repo/objects/:id`                       | Object get; body is the inflated payload, `Content-Type: application/octet-stream`, `X-Sharp-Kind` header |
| `HEAD /repos/:repo/objects/:id`                       | Existence check (no body) for clone/pull negotiation                                                      |
| `GET  /repos/:repo/refs`                              | List refs                                                                                                 |
| `GET  /repos/:repo/refs/*`                            | Read a single ref                                                                                         |
| `PUT  /repos/:repo/refs/*`                            | Atomic CAS update (`If-Match: <old-hash>`; missing header = create-only)                                  |
| `POST /repos/:repo/commits`                           | High-level create-commit; takes tree, parents, author, message; returns id                                |
| `POST /repos/:repo/episodes`                          | Open an episode; returns episode id                                                                       |
| `POST /repos/:repo/episodes/:id/artifacts`            | Append an artifact (one row per call)                                                                     |
| `POST /repos/:repo/episodes/:id/finish`               | Finalize with status and optional `promoted_commit`                                                       |
| `POST /repos/:repo/episodes/:id/links`                | Link to another episode with a relation                                                                   |
| `GET  /repos/:repo/episodes`                          | Query episodes (filter params: model_id, status, parent_commit, …)                                        |
| `POST /repos/:repo/representations/:object_id/:layer` | Upsert a semantic representation                                                                          |
| `GET  /repos/:repo/representations/:object_id/:layer` | Read a semantic representation                                                                            |
| `POST /repos/:repo/git/import`                        | One-shot: ingest a Git URL or a local bare repo path                                                      |
| `POST /repos/:repo/git/export`                        | One-shot: emit a linear branch to a Git URL or bare repo path                                             |
| `POST /repos/:repo/query`                             | Read-only SQL passthrough (operator scope only)                                                           |
| `GET  /healthz`                                       | Liveness                                                                                                  |

### 4.2 Auth Model

Bearer-token authentication. Tokens belong to principals (`api_keys(token_hash, principal, scope)`). Three scopes for v1:

- `read` — object/ref/representation/episode reads.
- `write` — everything `read` plus object puts, ref CAS, commit/episode writes, semantic-rep upserts, git import/export.
- `operator` — everything `write` plus `POST /repos/:repo/query` and `POST /repos`. The operator-only namespace keeps SQL passthrough out of the agent harness's hands by default.

Tokens are stored hashed (sha256 of the secret); the secret is shown to the user once at creation. Per whitepaper §10.3, episode-level read scopes — granting a principal access to commits and refs without raw episode traces — are **required** for v1 and slot in as a `read_no_episodes` scope.

### 4.3 Bun-Native HTTP

`Bun.serve()` plus a small hand-rolled router (radix or sorted-array of route patterns; nothing fancy needed for ~25 endpoints). No Express, no Fastify. If middleware ergonomics become painful we adopt `hono` — the call is cheap to make later.

Request-scoped logger (request id from `X-Request-Id` or generated, structured json logs to stdout). 30s default request timeout; 5min for `git import` and the SQL passthrough; 60s default for everything else.

### 4.4 Error Model

Errors are JSON: `{ error: { code: "ref_cas_failed", message: "...", details: {...} } }`. Codes are stable strings. HTTP status mirrors:

- `400` invalid input (bad object kind, malformed ref name)
- `401` no token
- `403` token lacks scope
- `404` repo/object/ref/episode not found
- `409` conflict (CAS failure, duplicate object with mismatched kind)
- `412` precondition (`If-Match` did not match)
- `500` server-side bug

## 5. Sharp Client Basics

### 5.1 Working-Tree Layout

Each Sharp checkout is a directory plus a `.sharp/` metadata folder:

```
my-repo/
├── .sharp/
│   ├── config            connection settings (server URL, repo, token ref)
│   ├── HEAD              symbolic or hash; mirrors Git's HEAD semantics
│   ├── refs/             local ref cache (heads/, tags/, remotes/)
│   ├── index             staged changes (binary; mirrors Git's index format spirit)
│   └── objects-cache/    optional local CAS to avoid round-tripping the server for re-reads
└── src/, README.md, …    actual working tree
```

`config` is INI-style (matches Git's `.git/config` ergonomics so operators with Git muscle memory aren't surprised). The token reference is a name pointing at a system credential store (Bun's `Bun.env` for dev, OS keychain for prod) — not stored in the file.

### 5.2 init / clone / add / commit

- **`sharp init`** writes `.sharp/`, queries the server for the repo's existence and default branch, sets up an empty index, points HEAD at `refs/heads/<default>`.
- **`sharp clone <server-url>/<repo>`** creates a directory, runs `init`, then walks the server's refs and reachable objects into `.sharp/objects-cache/`, finally checks out the default branch.
- **`sharp add <path>`** computes blob IDs for added/modified files, puts them into the server's CAS, updates the index. Deletions also tracked. The index is a simple list of `(path, mode, blob_id, size, mtime)` tuples; mtime is for staleness detection only, not commit content.
- **`sharp commit -m <msg>`** builds a tree object from the index (recursive subtree construction), creates a commit object referencing HEAD's current commit as parent, advances HEAD's referenced ref atomically (CAS).

The implementation borrows heavily from Git's design at this layer because there is no good reason to deviate. The deviation is the storage substrate, not the semantics.

### 5.3 branch / pull / push

- **`sharp branch <name> [start-point]`** updates `.sharp/refs/heads/<name>` and creates the matching server ref.
- **`sharp checkout <ref>`** updates HEAD and materializes the working tree from the target commit's tree.
- **`sharp pull`** fetches updated refs from the server, fetches reachable objects the local cache lacks, fast-forwards or runs `sharp merge` if HEAD has diverged.
- **`sharp push`** is a CAS-style ref update on the server: "advance refs/heads/X from $local_remembered to $local_current." On failure (someone else pushed first), the client surfaces a clear error and refuses to overwrite — no `push --force` in v1.

### 5.4 Network Negotiation

Clone/pull negotiation is intentionally simple in v1 (we are not implementing Git's smart protocol):

1. Client requests the server's ref list.
2. Client diffs server refs against local cache; for each ref the client doesn't have, walks reachability from the server's object graph by issuing `HEAD /objects/:id` until it finds an object it already has, building a "want" list.
3. Client streams `GET /objects/:id` for each want.

This is `O(refs * walk-depth)` HEAD requests. Not as efficient as a packfile negotiation, but adequate for v1 — we are not the network bottleneck for agent-driven work, and the simplicity is worth the bandwidth cost. A pack-style negotiation is a v2 optimization if measurements demand it.

### 5.5 Working-Tree Materialization and Conflict Output

When `sharp checkout` or `sharp merge` writes the working tree, it does so from the canonical tree object — file modes (100644/100755/120000) preserved, line endings unmodified, symlinks created when supported. No autocrlf. No filter drivers. v1 is deliberately faithful to the bytes Sharp stored.

Conflict output: when Sharp's merge engine cannot resolve, the client writes the dilemma payload to `.sharp/MERGE_DILEMMA.json` and prints a summary to stderr with a non-zero exit code. The client never writes `<<<<<<<` markers — that's a textual-merge artifact Sharp does not produce.

## 6. Semantic Layer: Language Servers, Not DIY Parsing

The primary path for semantic analysis in Sharp is the language's own production toolchain. When a language already has a production-grade language server, Sharp calls it — it does not reimplement symbol extraction, reference resolution, or rename tracking itself. Tree-sitter is retained as a lightweight parse check and as a fallback for languages that do not yet have a mature LSP.

### 6.1 Language Server Backends

**TypeScript** — `ts.LanguageService` (TypeScript Compiler API). Already implemented in `apps/client/src/semantic/symbols.ts`. Sharp constructs a `LanguageServiceHost` backed by the materialized candidate tree and calls into the compiler API directly — no subprocess, no LSP wire protocol overhead for the primary TypeScript path.

**Rust** — `rust-analyzer` LSP subprocess (planned Phase 19.x). Sharp spawns rust-analyzer as a subprocess, initializes an LSP session against the candidate project root, and issues standard LSP requests (`textDocument/rename`, `textDocument/callHierarchy`, `textDocument/diagnostic`). See `research.md` §10 for the known gaps (initialization latency, indexing time, clean shutdown).

**Other languages** — Tree-sitter as a fallback approximation. Files outside the TypeScript/Rust set are still tracked as blobs and get a tree-sitter parse check; symbol extraction at this level is best-effort. Their merges fall back to text three-way merge or, in v1, are reported as conflicts the operator must resolve manually.

### 6.2 Call Graph Analysis

Call hierarchy analysis gives Sharp a cross-file understanding of a change's blast radius before the merge engine attempts resolution:

- **TypeScript**: `languageService.getCallHierarchyItems()` / `callHierarchy/incomingCalls` — enumerates every call site of a function transitively.
- **Rust**: rust-analyzer `callHierarchy` — equivalent LSP call hierarchy capability.
- **Use case**: before Tier 1 attempts rename propagation, Sharp queries the call graph to enumerate all files that reference the renamed symbol. This scopes the edit set precisely and allows the merge engine to fail fast if a referenced file is not in the candidate tree.

### 6.3 Storage and Cache Lifecycle

Semantic representations are stored in the `representations` table keyed on `(object_id, layer, version)`. Layers in v1: `symbols`, `references`, `diagnostics`. The `version` column captures the language server / extractor version; queries for "the current symbols for this blob" pin the version Sharp's running, and stale rows for older versions are reaped on a TTL.

Cache invalidation policy: on toolchain or language server version bump, all rows with the old version remain (audit trail) but lookups never hit them. A background reaper deletes rows older than 30 days that are not referenced by any extant query. v1 ships the reaper as a manual command (`sharp admin reap-representations`); automatic background reaping is post-v1.

## 7. Merge Engine

### 7.1 Tier 1 — Deterministic Semantic Merge

Inputs: three trees (base, branch_a, branch_b). For each path:

1. **Both branches identical to base** → take base.
2. **One branch identical to base, the other modified** → take the modified.
3. **Both branches modified, but to identical content** → take either.
4. **Both branches modified, content differs** → semantic merge:
   - Both files are in supported languages → AST-level merge (see below).
   - Otherwise → conflict (v1 does not text-merge unsupported languages).

The AST-level merge:

- Match nodes between base, A, B by structural identity (kind + scoped name) plus a stable-id heuristic for anonymous nodes.
- For each matched node:
  - If A and B both modified and the modifications are non-overlapping (different child subtrees) → take both.
  - If A and B both modified and overlap → either pick the one consistent with the other's renames, or surface as a conflict candidate.
- Rename propagation calls `findRenameLocations()` (TypeScript via `ts.LanguageService`) or `textDocument/rename` (Rust via rust-analyzer LSP) to get the complete set of edit locations for any detected rename. This is the same API editors use for F2-rename; Sharp gets a correct-by-construction reference list rather than approximating it via pattern matching. References to the old name in B-side files are rewritten to the new name during merge — this is the move that converts the canonical `clean_wrong` cross-file-rename scenario into `clean_ok`.
- File-level renames (path move + content edit) are reconstructed by matching tree entries by content-hash and moderate-similarity body comparison.

The output of Tier 1 is a _set_ of candidate merge trees (typically one, sometimes more when rename detection has multiple plausible interpretations).

### 7.2 Intrinsic Verification

Every Tier 1 candidate must pass Sharp's **intrinsic structural verification** before being emitted as a candidate merge tree. Structural verification uses the language's own diagnostic APIs:

- Every modified file parses cleanly (Tree-sitter parse-level check).
- TypeScript candidates: `ts.LanguageService.getSemanticDiagnostics()` and `getDeclarationDiagnostics()` run against the merged virtual project. Any error-level diagnostic drops the candidate.
- Rust candidates: `cargo check --message-format=json` runs against the merged candidate tree. Any `error`-level message drops the candidate.
- Symbol references resolve against the merged symbol table (as reported by the language server).
- Cross-file rename propagation, when performed, leaves no dangling references to the renamed-away identifier.

A candidate that fails any intrinsic check is dropped. If only one candidate exists and it fails, Sharp escalates directly to Tier 3 with the failures attached.

This is distinct from the hooks system: intrinsic verification is always on and uses the LS diagnostic APIs Sharp already invokes for rename. Hooks (§7a) layer on additional project-specific or operator-chosen checks beyond what the language server reports.

Future work: control-flow graph analysis (research.md §2) catches a further class of merge breakages and would slot into the intrinsic verification layer; v1 stops at Tree-sitter parse + symbol resolution.

### 7a. Hooks (Decoupled Toolchain Integration)

Sharp's merge engine is intrinsic-only by design. Anything that involves a language toolchain, project layout, or operator policy is layered on through **hooks**, modeled on Git's hooks: per-repository or per-workspace executable scripts triggered at lifecycle events.

**Why hooks instead of a built-in compiler step.** Coupling the merge engine to `tsc`/`cargo` would make Sharp's contract dependent on toolchain versions, install layouts, monorepo conventions, and per-project tsconfig/cargo settings — none of which Sharp can reasonably own. Hooks delegate that variance to the user, while keeping Sharp's intrinsic contract portable.

**Events.**

| Event         | When it fires                                                               | Veto? |
| ------------- | --------------------------------------------------------------------------- | ----- |
| `pre-commit`  | After staging is finalized, before the commit is created                    | Yes   |
| `post-commit` | After a commit has been created and the ref advanced                        | No    |
| `pre-merge`   | For each Tier 1 candidate that passes intrinsic verification, before Tier 2 | Yes   |
| `post-merge`  | After a successful merge                                                    | No    |
| `pre-push`    | Before client → server push                                                 | Yes   |
| `pre-receive` | Server-side, before accepting a pushed ref update                           | Yes   |

**Layout.**

- Per-workspace hooks live in `.sharp/hooks/<event>/` (multiple hooks per event allowed; executed in lex order).
- Server-side hooks live in the repo's server-side configuration (a `repo_hooks(repo_id, event, path, enabled)` table).
- Stock example hooks ship under `examples/hooks/` — `tsc-noemit.ts`, `cargo-check.ts`, `prettier-check.ts`. Users opt in by symlinking or copying.

**Execution model.**

- Each hook receives context as JSON on stdin (event name, repo, candidate tree path on disk for `pre-merge`, paths-changed list for `pre-commit`, etc.).
- A non-zero exit code is a veto where the event supports veto (table above). Stdout/stderr are captured and surfaced in the dilemma payload (for `pre-merge` failures) or the user-facing error message (for `pre-commit` / `pre-push` failures).
- Wall-clock timeout default: 60s per hook, configurable via `SHARP_HOOK_TIMEOUT_MS`.
- Hooks run with the same pinned-environment philosophy as the test harness's lane runners — no developer-config bleed-through, deterministic env vars.

**Pre-merge integration.** Tier 1 produces N candidate trees. Sharp's intrinsic verification drops invalid candidates. The remaining candidates are passed through every installed `pre-merge` hook in lex order; any veto drops that candidate. Whatever survives goes to Tier 2.

The `tsc --noEmit` example hook (`examples/hooks/tsc-noemit.ts`) is what the test corpus's clean*wrong scenarios will rely on in CI to demonstrate Sharp converting them to clean_ok — but it is the \_user's* hook on the _test fixture's_ `.sharp/hooks/` directory, not part of Sharp's merge engine.

### 7.3 Tier 2 — Automatic Downstream Oracle

When more than one candidate survives the gate, Sharp consults the repo's **other in-development branches** as ground truth. Specifically:

- Enumerate refs under `refs/heads/` reachable from the same parent commit as the merge.
- Exclude the two branches being merged.
- For each candidate, compute a 3-way merge of `(parent, candidate, oracle_branch_tip)` for each oracle branch.
- The candidate that introduces the fewest new conflicts (across all oracle branches) wins. Ties → fall through to Tier 3.

This is the implementation of the test plan's `branch_c/` mechanism. No fixture-author tuning, no scoring weights — just "which candidate composes most cleanly with how the codebase is actually evolving."

### 7.4 Tier 3 — Structured Dilemma

Sharp emits a JSON object the calling agent (or human operator) reads:

```json
{
  "kind": "dilemma",
  "scenario": "<merge id>",
  "candidates": [
    {
      "id": "candidate_1",
      "summary": "rename propagated to file X",
      "verification": { "passed": true, "errors": [] },
      "oracle": { "consulted_branches": [...], "conflicts_introduced": 0 }
    },
    {
      "id": "candidate_2",
      "summary": "rename not propagated; file X retains old name",
      "verification": { "passed": false, "errors": ["TS2304: Cannot find name 'foo'"] },
      "oracle": { ... }
    }
  ],
  "involved_paths": ["src/api.ts", "src/extras.ts"],
  "ast_nodes_in_tension": [...]
}
```

The exact field set is the minimum a calling agent needs to make a real decision; the format will evolve once real dilemmas appear in the corpus (research.md §7). v1 commits only to the shape above plus a stable schema version (`"sharp_dilemma": 1`) so consumers can migrate.

### 7.5 The `sharp merge` Command

```
sharp merge <branch>
sharp merge --abort
sharp merge --resolve <candidate-id>     # operator override after Tier 3
```

Exit codes:

- `0` — clean merge produced; HEAD's branch advanced atomically.
- `1` — dilemma escalated; `.sharp/MERGE_DILEMMA.json` written; HEAD unchanged.
- `2` — error (network, server, internal bug).

`--resolve` lets a human or agent explicitly select one of the dilemma's candidates, bypassing Tier 3 escalation. The choice is recorded as a commit-metadata annotation (`"merge_resolution": { "via": "operator-override", "candidate": "candidate_1" }`) for replay/audit.

### 7.6 Continuous Speculative Merge

Implements the "no rebase ever" feature from whitepaper §6.7. A thin server-side layer plus client + CLI surface, built on the merge engine above.

#### Storage

```sql
projections (
  repo_id uuid not null,
  branch_ref text not null,             -- e.g. 'refs/heads/feature/x'
  target_ref text not null,             -- e.g. 'refs/heads/main'
  branch_tip bytea,                     -- commit ID at last computation
  target_tip bytea,                     -- commit ID at last computation
  projection_commit bytea,              -- the resulting Sharp commit ID, or null on dilemma
  status text not null check (status in ('clean','dilemma','stale','error')),
  dilemma jsonb,                        -- the §7.4 dilemma payload, when status='dilemma'
  computed_at timestamptz not null,
  primary key (repo_id, branch_ref, target_ref)
);
```

A trigger on `refs` updates marks any matching projection rows as `status='stale'`. The next read recomputes lazily.

#### Compute path

`recomputeProjection(repo, branch_ref, target_ref)`:

1. Resolve `branch_tip = refs[branch_ref]`, `target_tip = refs[target_ref]`. If either ref is gone, drop the projection row.
2. Find the merge base of `(branch_tip, target_tip)`.
3. Run the full merge engine: Tier 1 → intrinsic verification → installed `pre-merge` hooks → Tier 2 oracle → Tier 3 dilemma (per §7.1–7.4).
4. On `clean_ok`: write the resulting tree as a new Sharp commit (parents = `[target_tip, branch_tip]` so the projection composes via standard reachability). Set `projection_commit`, `status='clean'`.
5. On `dilemma`: leave `projection_commit` null, set `status='dilemma'`, write the payload to `dilemma`.
6. Update `branch_tip`, `target_tip`, `computed_at` atomically with the projection row.

Single-flighted per `(repo, branch, target)` via a Postgres advisory lock so concurrent reads of a stale projection don't all kick off duplicate recomputes.

#### API

| Verb + path                                             | Purpose                                       |
| ------------------------------------------------------- | --------------------------------------------- |
| `POST /repos/:repo/projections`                         | Register a `(branch_ref, target_ref)` pair    |
| `GET /repos/:repo/projections/:branch--:target`         | Read current projection (recomputes if stale) |
| `GET /repos/:repo/projections/:branch--:target/dilemma` | Dilemma payload when status=dilemma           |
| `DELETE /repos/:repo/projections/:branch--:target`      | Stop tracking                                 |
| `GET /repos/:repo/projections?status=dilemma`           | All outstanding dilemma projections           |

#### Client / CLI

- `sharp project <branch> --target <ref>` — register a projection; prints current status.
- `sharp project list` — show all registered projections in the workspace.
- `sharp project preview <branch>` — print the projection commit, or the dilemma payload if blocked.
- `sharp merge <branch>` — when a clean projection exists, merge becomes a CAS that advances `target_ref` to `projection_commit`. The merge engine does not re-run.
- `sharp git export <branch> <target> <git-url>` — exports the projection (linear sequence of commits on top of `target_tip`), not the feature branch's actual DAG.

#### Why this is not just an auto-merge loop

A naive "auto-merge main into feature" loop produces merge commits on the feature branch every time main advances, polluting history and forcing force-pushes anyway. The projection is a **separate ref** (`refs/sharp-merged/<feature>--<target>`) with its own commit; the feature's tip is always exactly what its author/agent committed. Merge churn lives on the projection ref, never on the feature.

#### Failure modes

- **Hook flake.** A `pre-merge` hook that times out marks the projection `status='error'` (distinct from `dilemma`); the operator fixes the hook and re-reads.
- **Cycle: feature branch advances mid-projection.** Projection's recorded `branch_tip` mismatches the current head; the result is published as stale immediately and the next read recomputes against the new tip.
- **Recompute storm when many branches share a target and the target advances.** Recomputation is lazy (on read); only actively-read branches pay the cost.

## 8. Git Interoperability

### 8.1 Import — `sharp git import <git-url>`

Implementation strategy: shell out to stock `git` for the network-and-pack work (we are not reimplementing the Git wire protocol per whitepaper §0), then walk the resulting object database into Sharp's CAS.

```
1. mktemp -d => $tmp
2. git clone --mirror <url> $tmp/source.git
3. for each object reachable from each ref in $tmp/source.git:
     hash, kind, payload = read object
     putObject(repo, kind, payload)  # Sharp's hash will match Git's
4. for each ref under refs/heads/, refs/tags/, plus HEAD's symbolic target:
     create the matching ref in Sharp
5. for each annotated tag object:
     stored as kind=tag — Sharp's whitepaper §4 already supports this; a small
     extension to the objects.kind check constraint adds 'tag' as a valid kind
6. for each commit:
     populate commit_paths
7. rm -rf $tmp
```

Submodules and Git LFS: per whitepaper §7.1, gitlinks (mode 160000) are preserved as tree entries; LFS pointer files are ingested as ordinary blobs; neither is recursively fetched. The CLI prints a clear note at import time so the operator isn't surprised later.

Signed commits: the signature lives inside the commit object's `gpgsig` header, which is part of the bytes Sharp hashes. Preserving canonical bytes means signatures survive import → export round-trip.

### 8.2 Export — `sharp git export <branch> <git-url>`

Strategy: build a fresh `git` bare repo on disk (or write packfile-style objects) and `git push` to the destination. Stock `git` does the wire work; Sharp produces byte-identical objects.

```
1. mktemp -d => $tmp
2. git init --bare --object-format=<sha1|sha256> $tmp/dest.git
3. confirm linear-only: walk <branch> from tip, every commit must have ≤1 parent
   reachable on this branch (refuse otherwise — see whitepaper §7.2)
4. for each commit on the branch, root-first:
     materialize tree/blobs into $tmp/dest.git/objects (loose form, zlib deflate)
5. write refs/heads/<branch> in $tmp/dest.git pointing at the tip
6. git --git-dir=$tmp/dest.git push <git-url> refs/heads/<branch>
7. rm -rf $tmp
```

### 8.3 Playback Guarantee

The user-facing contract: **a stock `git` client can clone the exported repo and check out every commit byte-for-byte**. Operationally:

- `git clone <url-the-export-pushed-to>` succeeds.
- `git log refs/heads/<branch>` lists every commit on the exported linear history.
- `git checkout <any-commit-on-the-branch>` produces a working tree byte-identical to what `sharp checkout <same-commit>` would produce.
- Commit SHAs match what Sharp computed (because Sharp stored Git-canonical bytes and used Git's hash).
- Signed-commit signatures verify if they verified before import.

This is enforced by the **Git export round-trip** test in v1-plan §3: 10 representative open-source repositories are imported and the linear `main` branch of each is exported; bit-comparing commit SHAs against the source is the regression net.

### 8.4 Object Byte-Canonicalization

Where most of the implementation work sits. Three object kinds with subtle serialization rules:

- **Blob** — payload is the file contents verbatim. Header is `blob <size>\0`. Trivial.
- **Tree** — entries sorted with the famous "directory sort" quirk: entry names are sorted bytewise _as if every directory entry had a trailing `/`_ (so `foo` sorts after `foo.txt` if `foo` is a directory). Modes are exact strings: `100644`, `100755`, `120000`, `160000`, `40000` (no leading zero on directory mode!). Each entry: `<mode> <name>\0<20-byte-binary-sha>`.
- **Commit** — header lines: `tree <hex>`, `parent <hex>` (zero or more, in original order), `author <name> <email> <unix-ts> <tz>`, `committer <...>`, optional `gpgsig <pem-block>` and other extension headers, blank line, message. Trailing newline matters. UTF-8 by default; `encoding <charset>` header for non-UTF-8.

A small TypeScript module (`apps/server/git/canonical.ts`) handles encode/decode of all three, with vitest unit tests covering edge cases (empty tree, multi-parent commit, commit with unicode message, signed commit, tree with submodule entry).

## 9. Agent Episode Library

### 9.1 Package Boundary

`@sharp/episodes` ships as a published npm package (workspace-internal in v1; published externally post-v1). Public API:

```typescript
import { Sharp, openEpisode } from '@sharp/episodes';

const sharp = new Sharp({ url: '...', token: '...', repo: 'my-repo' });

const ep = await openEpisode(sharp, {
  parent_commit: '<hex>',
  agent_identity: 'codex-worker-42',
  model_id: 'claude-opus-4-7',
  harness_version: '0.1.3',
  tool_versions: { tsc: '5.5.0', cargo: '1.92.0' },
  decoding_params: { temperature: 0.2, top_p: 0.9 },
});

await ep.appendArtifact('prompt', { role: 'system', content: '...' });
await ep.appendArtifact('tool_call', { tool: 'apply_patch', args: { ... } });
await ep.appendArtifact('intermediate_patch', someBigBuffer);   // CAS pointer; auto-routed
await ep.appendArtifact('validation', { result: 'pass', tool: 'tsc' });
await ep.appendArtifact('judge', { score: 0.87 });

await ep.finish({ status: 'completed', promoted_commit: '<hex>' });
```

Design notes:

- Inline jsonb payloads are detected by `JSON.stringify(value).length < 64KB`; everything else is stored as a CAS object and `content_ref` is set. The library handles routing transparently.
- `appendArtifact` is fire-and-await; no batching in v1 (batching is a perf optimization for later).
- `openEpisode` is the only operation that requires a parent commit; the rest of the lifecycle does not.

### 9.2 Replay Primitive

```typescript
const replayed = await ep.replay({
  model_id: 'claude-opus-4-8', // override one or more provenance fields
  harness_version: '0.2.0',
});
```

Replay reads the original episode's `prompt`/`context`/`tool_call` artifacts, reconstructs the conversation, and runs it against the new model/harness. Each tool call invokes the harness's tool implementations (shelled out per the original `tool_versions`). The replay creates a **new** episode linked back via `episode_links.relation = 'replay_of'`.

The replay-as-evaluation methodology — what to measure across replays, how to summarize divergence — is research-track (research.md §6). v1 ships only the mechanism.

### 9.3 Failed-Sibling Linking

Harnesses running fan-out attempts call `episode.linkSibling(otherEpisodeId)` for each peer. After the judge picks a winner, the chosen episode calls `episode.markSuperseded(losingEpisodeIds)` which writes `superseded_by` links from the losers to the winner. Both are simple `episode_links` inserts — the library is a thin convenience over the HTTP API.

### 9.4 Redaction

`sharp.redactArtifact(episode_id, seq, { policy: 'pii-v1', redacted_value: '<…>' })` rewrites the artifact's payload (or repoints its `content_ref` at a pre-redacted CAS object) and inserts a row in an audit log table (`episode_redactions(episode_id, seq, policy, actor, redacted_at)`). The original payload is **gone** — redaction is destructive by design; the audit trail records what was scrubbed and why, not what the original was.

## 10. Server Analytics

### 10.1 Hot Indexes

The three queries v1 must answer cheaply (v1-plan §6):

- **"all episodes that touched file X"** —

  ```sql
  select e.* from episodes e
  join commit_paths cp on cp.commit_id = e.promoted_commit and cp.repo_id = e.repo_id
  where cp.repo_id = $1 and cp.path = $2;
  ```

  Backed by `commit_paths(repo_id, path)`. Fast.

- **"all failed siblings of commit Y"** —

  ```sql
  select sib.* from episodes winner
  join episode_links el on el.to_episode = winner.id and el.relation = 'sibling'
  join episodes sib on sib.id = el.from_episode
  where winner.repo_id = $1 and winner.promoted_commit = $2 and sib.status in ('failed','abandoned');
  ```

  Backed by `episodes(promoted_commit)` and the `episode_links` PK.

- **"all episodes using model Z, with success rate by harness version"** —
  ```sql
  select harness_version,
         count(*) filter (where status = 'completed' and promoted_commit is not null) as wins,
         count(*) as total
  from episodes
  where repo_id = $1 and model_id = $2
  group by harness_version
  order by wins::float / total desc;
  ```
  Backed by `episodes(repo_id, model_id, status)`.

### 10.2 SQL Passthrough

`POST /repos/:repo/query` accepts a JSON body `{ sql, params }` and runs the query under a **read-only transaction** with a 5-second statement timeout, against a Postgres role that has `SELECT` on the relevant tables only. The response streams rows as JSON.

Operator-only scope (per §4.2). The `sharp query <sql>` operator command wraps this endpoint.

Security: the read-only role cannot see the `api_keys` table, the `episode_redactions` audit log, or the redacted episode payloads. A dedicated `analytics_role` with explicit `GRANT SELECT` per analytics-relevant table; everything else is implicitly denied.

### 10.3 Materialized Views (Maybe)

If the v1 benchmark thresholds are not met by base-table queries, three materialized views are candidates:

- `mv_episodes_by_path` — denormalized join of episodes × commit_paths.
- `mv_model_success_rates` — pre-aggregated model × harness × status counts.
- `mv_fanout_groups` — pre-grouped sibling clusters with selected/rejected status.

Refresh policy: incremental triggers on the underlying tables. v1 ships these only if benchmarks demand them; otherwise queries hit base tables and the materialized views are post-v1.

## 11. Operator CLI

The operator-side commands extend the Sharp client with read/write access to the unified store:

- `sharp episode list [--filter ...]` — paginated episode list.
- `sharp episode show <id>` — full episode payload incl. artifacts, links, status.
- `sharp episode redact <id> <seq> --policy <name>` — calls the redaction endpoint.
- `sharp episode replay <id> [--model X] [--harness Y]` — invokes the replay primitive.
- `sharp query <sql>` — read-only SQL passthrough.
- `sharp admin create-repo <name>` — operator-only.
- `sharp admin issue-token --principal <p> --scope <s>` — operator-only.
- `sharp admin reap-representations [--older-than 30d]` — manual representation cache reaper.

All operator commands require a token with `operator` scope.

## 12. Configuration, Build, and Deployment

### 12.1 Server

Single binary built with `bun build --compile`. Configuration via env vars (matches superfield/template):

| Env var                 | Purpose                                        |
| ----------------------- | ---------------------------------------------- |
| `SHARP_DSN`             | Postgres DSN                                   |
| `SHARP_PORT`            | HTTP listen port (default `5174`)              |
| `SHARP_DEFAULT_HASH`    | `sha1` (default) or `sha256`                   |
| `SHARP_LOG_LEVEL`       | `info` / `debug`                               |
| `SHARP_AUTH_DISABLED`   | `1` to disable auth (dev only; never in prod)  |
| `SHARP_MIGRATE_ON_BOOT` | `1` to run migrations on startup (default `1`) |

Server startup sequence: connect to PG, run pending migrations, listen on PORT.

### 12.2 Client

`sharp` CLI binary built the same way. Per-workspace config under `.sharp/config`; per-user config under `$XDG_CONFIG_HOME/sharp/config`. Token storage via OS keychain by default with a `--token-from-env` escape hatch for CI.

### 12.3 Container Image

Server packaged as a Docker image based on `oven/bun:1`. Sharp v1 does not require docker for production deploy — the bun-compiled binary plus a Postgres are sufficient — but the image makes superfield-style deployment trivial. The CLI is shipped as a standalone binary, not in the server image.

### 12.4 Local Dev

`sharp dev` starts a local Postgres via the same `tests/harness/pg-container.ts` helper, runs migrations, starts the server, and opens an interactive shell with `SHARP_URL` pre-populated. One command, zero ceremony.

### 12.5 Migrations

A single Bun script (`apps/server/migrate.ts`) reads `apps/server/migrations/*.sql` in lex order, compares against `schema_migrations`, applies pending files in a transaction. No down-migrations in v1 — moving forward only is simpler and matches superfield/template's posture. Reverting bad migrations is a "ship a new migration that undoes it" exercise.

## 13. Observability and Operations

- **Structured JSON logs** to stdout. Fields: `ts`, `level`, `request_id`, `repo`, `route`, `latency_ms`, `outcome`, plus operation-specific context.
- **Slow-query log** — any query > 250ms emits a warn-level log with the SQL text (parameterized; values sanitized) and EXPLAIN output. Off by default in production via `SHARP_SLOW_QUERY_MS=...`.
- **Health endpoints** — `GET /healthz` (liveness, returns `{ ok: true, version: ... }`), `GET /readyz` (DB pingable; migrations applied).
- **Metrics** — Prometheus-style `/metrics` endpoint with request count/latency histograms by route, episode-write throughput, ref CAS retry counter, slow-query counter. Out of scope for v1 _if_ it doesn't fit the time budget; in scope if it does.

## 14. Test Strategy Beyond the Corpus

### 14.1 Replacing the Sharp Lane Stub

The current Sharp lane in `tests/harness/lanes/sharp/index.ts` returns `error` unconditionally. Replacement happens in two steps:

1. **Lane-only Sharp.** A Sharp client/server combo that performs `init / commit base / branch + commit branch_a / branch + commit branch_b / merge`. Initially the merge is a thin wrapper around `git merge` so the Sharp lane proves the plumbing without claiming any semantic improvement. This lights up `--only-sharp` mode for the corpus.
2. **Real merge engine.** Tier 1 + intrinsic verification land first. Hooks system lands alongside, and the seed-corpus fixtures install `examples/hooks/tsc-noemit.ts` and `examples/hooks/cargo-check.ts` into their `.sharp/hooks/pre-merge/` directories — that's how the corpus's `clean_wrong` scenarios convert to `clean_ok`. Tier 2 oracle and Tier 3 dilemma follow. Each green scenario is a release-note moment.

### 14.2 Unit Tests

Beyond the corpus, vitest unit tests cover:

- `apps/server/git/canonical.ts` — encode/decode round-trip for blob/tree/commit/tag, edge cases (empty tree, multi-parent, signed, encoded).
- `apps/server/cas.ts` — content-addressed put/get, hash recomputation, SHA-1DC integration, mixed-algo per-repo.
- `apps/server/refs.ts` — CAS update wins/loses races, symbolic ref resolution, ref namespace boundaries.
- `apps/server/commit.ts` — commit creation reachability check, multi-parent paths-touched walk.
- `apps/server/migrate.ts` — applying, idempotence, mid-transaction failure rollback.
- `packages/episodes/index.ts` — inline-vs-CAS routing, redaction invariants, replay-link relation.
- `apps/client/index.ts` — `.sharp/` layout, index serialization, working-tree materialization byte-for-byte.

### 14.3 Performance Benchmarks

Per v1-plan §3 thresholds. Bench harness lives at `apps/server/bench/` and is invoked via `bun run bench`. Three suites:

- `commit-throughput` — 10k commits, p50/p99 latency.
- `checkout-throughput` — 10k-file tree, materialize time.
- `episode-ingest` — 10k episodes with mixed inline+CAS artifacts; sustained throughput.

A failing bench is **not** a CI-blocker in v1 (we are in a discovery phase); it is a release-note item flagged for follow-up. v1's promise is "we measure"; v2's promise is "we hit thresholds reliably."

### 14.4 The 10-Repo Round-Trip Suite

Bench harness `apps/server/bench/git-roundtrip.ts` clones 10 representative open-source repositories (a hand-picked list spanning small/medium/large, TypeScript/Rust/mixed, with-merges/linear-only), runs `sharp git import` followed by `sharp git export <main> file://...`, and bit-compares commit SHAs. Listed repos are pinned to specific commit hashes so the benchmark is reproducible.

## 15. Phased Delivery (Refined Against v1-plan §4)

### Phase 1 (Weeks 1–4) — Storage and Client Plumbing

- Server: schema + migrations, CAS, refs (CAS), commit creation, HTTP API for object/ref/commit endpoints, auth scaffolding.
- Client: `.sharp/` layout, `init/clone/add/commit/branch/checkout/pull/push`. Network negotiation is the simple HEAD-walk model.
- Git canonical encode/decode unit-tested.
- Operator CLI: `sharp admin create-repo`, `sharp admin issue-token`.
- **Done = the Sharp lane plumbing test (§14.1 step 1) is green:** lane runs `init → branch → branch → merge` (where merge wraps `git merge`) end-to-end and reports clean_ok / conflict back to the harness.

### Phase 2 (Weeks 5–8) — Episodes and Operator Surface

- Server: episode schema migrations, episode/artifact/links endpoints, redaction endpoint with audit log.
- `@sharp/episodes` library.
- Operator CLI: `sharp episode list/show/redact/replay`, `sharp query`.
- Read-only analytics role and the SQL passthrough endpoint.
- **Done =** a reference agent harness can open, append to, finish, and replay episodes via the library; sample analytics queries from §10.1 return correct results on a populated database.

### Phase 3 (Weeks 9–12) — Semantic Merge and Git Interop

- Language server integration: `ts.LanguageService` host backed by the materialized candidate tree (TypeScript); rust-analyzer LSP subprocess scaffolding (Rust). Tree-sitter retained for parse-level checks and non-TS/Rust languages.
- Tier 1 deterministic merge using `findRenameLocations()` / `textDocument/rename` for rename propagation; intrinsic verification using `getSemanticDiagnostics()` / `cargo check --message-format=json`. Hooks system lands alongside with stock `examples/hooks/`. The corpus's `clean_wrong` scenarios flip green via these LS-backed checks.
- Tier 2 oracle, Tier 3 dilemma. Most remaining `conflict` scenarios flip green.
- `sharp git import` and `sharp git export`. The 10-repo round-trip suite passes.
- **Done =** the full corpus (`bun run test:differential`) reaches its target outcomes. The two `dilemma` scenarios (delete-then-edit) report `dilemma`; everything else reports `clean_ok`. CI's differential workflow flips from RED to GREEN.

## 16. Risks and Mitigations

| Risk                                                                               | Mitigation                                                                                                                                              |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language server rename detection mis-fires and Sharp emits wrong merges            | `getSemanticDiagnostics()` / `cargo check` verification gate catches anything that fails to type-check; corpus catches semantic regressions per fixture |
| Postgres-as-store fails performance thresholds                                     | v1-plan §6 success criterion includes "or pivot blob storage to external CAS with documented migration path"                                            |
| Git canonical-byte preservation has subtle bugs (signed commits, unicode messages) | The 10-repo round-trip suite (§14.4) bit-compares SHAs — any drift is caught                                                                            |
| Tier 2 oracle is too aggressive, picks wrong candidate from oracle branches        | Rare in practice (most cases land at Tier 1); when it happens, gate failure on the "wrong" candidate dropping it                                        |
| Episode storage growth under high fan-out                                          | CAS dedup of artifact payloads; retention policy is research-track but the storage primitives don't preclude it                                         |
| Schema migration applied incorrectly in production                                 | Migrations run in a transaction; failed migrations roll back; `SHARP_MIGRATE_ON_BOOT=0` lets operators run manually                                     |
| Auth model too simple for some deployments                                         | Bearer tokens + scopes are the minimum; OAuth/OIDC integration is post-v1                                                                               |

## 17. Out of Scope

Pointers, not duplications:

- **Cross-language semantic merge** — research.md §1.
- **Control-flow graph analysis** — research.md §2.
- **AST stability across grammar bumps** — research.md §3.
- **Multi-language symbol normalization** — research.md §4.
- **Episode retention policy** — research.md §5.
- **Replay-as-evaluation methodology** — research.md §6.
- **Tier 3 dilemma format DSL beyond the §7.4 minimum** — research.md §7.
- **Closed-loop learning, multi-tenant crypto isolation, OSS conflict mining** — research.md §9.

Anything in the v1-plan §5 "Out of Scope" list (Git server / wire protocol, bidirectional sync, submodule recursion, LFS object fetch, large-file policies, customer-held-key encryption, eval-loop tooling) is also out of scope here by reference.

## 18. Definition of Done for v1

A reasonable observer can verify v1 is shipped by checking:

1. `bun run test:differential` runs the full corpus and exits 0; the contingency table shows Sharp converting all of git's `conflict` and `clean_wrong` cells to `clean_ok` (except for the deliberate `dilemma` scenarios).
2. `apps/server/bench/git-roundtrip.ts` succeeds on the 10-repo suite.
3. A stock `git clone` of an exported Sharp branch produces a working tree that `sharp checkout` of the same commit also produces, byte-for-byte, on every commit.
4. The reference agent harness in `examples/` opens, appends to, finishes, and replays episodes end-to-end against a running server.
5. The SQL queries in §10.1 return correct results on a populated database in under the §3 latency budget.
6. CI's three workflows (`quality-gate`, `meta-pg-container-harness`, `test-differential`) are all GREEN on `main`.

That's v1. Everything past it is post-v1 by definition.
