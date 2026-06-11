# Client Architecture & Working Tree

> Status note. The Rust crate (`crates/sharp`) is the authoritative Sharp
> implementation, but is currently a **server-side library**: object store,
> refs, commits, and working-tree snapshot/materialize primitives. The
> client-side `.sharp/` shadow, the staging index, and the clone/pull/push CLI
> are **specified but not yet implemented in Rust**; features described only in
> `engineering-plan.md` §5 are marked **(planned)**. The deprecated TypeScript
> prototype (`deprecated/sharp-ts/apps/client/src/{workspace,http,cli}.ts`)
> shows the intended shapes and is cited as insight only.

## 1. Problem Statement

A Sharp checkout bridges two worlds: a developer's (or agent's) ordinary
directory of files, and Sharp's server-side content-addressed store (CAS) of
blobs, trees, and commits in Postgres. The client snapshots the working
directory into canonical objects, pushes those objects and a commit to the
server, materializes any commit's tree back onto disk byte-for-byte, and
synchronizes refs without losing concurrent writes. Unlike Git, the object
store is remote and shared, so the client is mostly a *projection* layer over
server state rather than a self-contained repository.

## 2. Core Concepts

- **CAS object** — a blob, tree, or commit keyed by its **git-canonical
  header-prefixed** digest `id = hash("<kind> <size>\0<payload>")`. Rust fixes
  the native algorithm to SHA-256 (`workspace.rs` `ALGO`); the TS prototype
  defaults to SHA-1. This is the only id a tree entry may embed.
- **Snapshot** — a path-sorted list of `FileSnapshot { path, mode, blob_sha }`
  from walking the working tree (`snapshot_working_tree`).
- **Tree** — the recursive directory object built from a snapshot
  (`build_tree_from_snapshot`); its root SHA is what a commit references.
- **Ref** — a named pointer in `sharp.refs`, either `Hash(sha)` (a branch/tag
  tip) or `Symbolic(name)` (e.g. `HEAD → refs/heads/main`); `refs.rs`
  `RefTarget`.
- **Index / staging** *(planned)* — a local `(path, mode, blob_id, size,
  mtime)` list under `.sharp/index`; `mtime` is staleness-only, never commit
  content (`engineering-plan.md` §5.2).

## 3. Architecture / Design

### 3.1 `.sharp/` shadow layout *(planned — engineering-plan §5.1)*

The Rust crate does not write this directory; it lists `.sharp` only in
`IGNORED_DIRS` so snapshots never ingest it. The planned layout is:

```
my-repo/
├── .sharp/
│   ├── config            connection settings (server URL, repo, token ref; INI-style)
│   ├── HEAD              symbolic or hash; mirrors Git's HEAD semantics
│   ├── refs/             local ref cache (heads/, tags/, remotes/)
│   ├── index             staged changes (path, mode, blob_id, size, mtime)
│   ├── objects-cache/    optional local CAS to avoid re-reading the server
│   ├── hooks/<event>/    per-workspace hooks (hooks.md)
│   └── MERGE_DILEMMA.json written on an unresolved merge (see §6)
└── src/, README.md, …    actual working tree
```

The token is *not* stored in `config`; `config` holds a reference into a system
credential store. What **is** persisted today is entirely server-side: objects
in `sharp.objects`, refs in `sharp.refs`, commit metadata in
`sharp.commit_metadata`/`commit_paths`. There is no on-disk client state in the
Rust crate yet.

### 3.2 Working-tree state machine

The client tracks three views of each path — `committed` (HEAD's tree),
`index` (staged), and `working_dir` (on disk). The implemented Rust primitives
realize the *transitions*, even though the persistent index that names the
states is still planned:

```
            edit on disk            sharp add               sharp commit
 committed ───────────────▶ modified ──────────▶ staged ──────────────▶ committed'
   ▲  │                       (working_dir≠index)  (index built into     (HEAD ref
   │  │ sharp checkout / materialize_tree              a tree object)      CAS-advanced)
   │  └─────────────────────────────────────────────────────────────────────┘
   │                         clear + rewrite disk from tree
   └── sharp pull (fast-forward)  /  sharp merge (divergent) ── conflict ─▶ MERGE_DILEMMA.json
```

- `sharp add` (planned CLI): `snapshot_working_tree` hashes each
  added/modified file as a blob, stores it via `object::store_canonical`, and
  records `(path, mode, blob_sha)`; deletions are tracked as `None` blobs.
- `sharp commit`: `build_tree_from_snapshot` folds the staged snapshot into
  tree objects, then `commit::commit` writes the commit object and advances the
  branch ref.
- `sharp checkout` / merge output: `materialize_tree` clears the working tree
  (everything except `.sharp/` and `.git/`) and rewrites it from a tree SHA,
  preserving modes `100644/100755/120000` and symlinks.

### 3.3 Sync protocol *(planned — engineering-plan §5.4)*

v1 deliberately avoids Git's smart/packfile protocol. Negotiation is a
HEAD-walk:

1. Client `GET /repos/:repo/refs`, diffs against its local ref cache.
2. For each missing ref, walk reachability by issuing `HEAD
   /repos/:repo/objects/:id` until it hits an object it already has, building a
   "want" list. Cost is `O(refs × walk-depth)` HEAD requests.
3. Stream `GET /repos/:repo/objects/:id` for each want.

Push is a CAS ref update — "advance `refs/heads/X` from `$remembered` to
`$current`" via `PUT /repos/:repo/refs/*` with `If-Match: <old-hash>`. A lost
race surfaces a clear error; there is no `push --force` in v1.

## 4. API / Interface

**Rust (implemented, in `crates/sharp/src`):**

```rust
// workspace.rs
async fn snapshot_working_tree(pool, repo_id: Uuid, root: &Path)
    -> Result<Vec<FileSnapshot>, SharpError>;
async fn build_tree_from_snapshot(pool, repo_id: Uuid, files: &[FileSnapshot])
    -> Result<String, SharpError>;            // returns root tree SHA-256
async fn materialize_tree(pool, root_tree_sha: &str, dest: &Path)
    -> Result<(), SharpError>;

// commit.rs
async fn commit(pool, repo_id, branch: &str, tree_sha, parent_sha: Option<&str>,
                message, author, paths: &[(String, Option<String>)]) -> Result<String>;
async fn create_branch(pool, repo_id, branch, target_sha) -> Result<()>;
async fn branch_head(pool, repo_id, branch) -> Result<String>;
async fn log(pool, repo_id) -> Result<Vec<CommitRecord>>;

// refs.rs  — note hash↔hash CAS is update_ref; HEAD moves via update_symbolic
async fn resolve_ref(pool, repo_id, name) -> Result<Option<String>>;
async fn update_ref(pool, repo_id, name, expected_old: Option<&str>, new_target) -> Result<()>;
async fn set_ref(pool, repo_id, name, sha) -> Result<()>;          // unconditional upsert
async fn update_symbolic(pool, repo_id, name, new_target) -> Result<()>;
```

**HTTP endpoints (engineering-plan §4.1; served by TS prototype, planned in Rust):**
`PUT|GET|HEAD /repos/:repo/objects/:id`, `GET|PUT /repos/:repo/refs/*`,
`POST /repos/:repo/commits`. The TS `SharpClient` (`http.ts`) wraps these as
`putObject`, `getObject`, `objectExists` (the negotiation HEAD), `listRefs`,
`updateRef` (`If-Match`), and `createCommit`.

**CLI (planned):** `sharp init | clone | add | commit | branch | checkout |
pull | push`. The Rust crate ships **no binary** today — these verbs are not
implemented; the TS `cli.ts` only exposes `dev`, `admin`, `repo`, `ref`, and
`project` subcommands, not the working-tree verbs.

## 5. Example: clone → add → commit → push

State snapshots below mix the implemented Rust calls with the planned client
wrapper.

1. **clone** *(planned)*: `init` writes `.sharp/`, sets `HEAD →
   refs/heads/main`; negotiation (§3.3) fetches reachable objects; the default
   branch is materialized via `materialize_tree(pool, head_tree, ".")`.
   *State:* `committed == index == working_dir`; index clean.

2. **edit** `src/lib.rs` on disk. *State:* `working_dir ≠ index` (modified).

3. **add**: `snapshot_working_tree` walks the root (skipping
   `.git/.sharp/node_modules/target/dist/.cargo`), stores the new blob under
   its canonical SHA-256, and stages `("src/lib.rs", 100644, <blob_sha>)`.
   *State:* `index ≠ committed`, `index == working_dir` (staged).

4. **commit**: `build_tree_from_snapshot` produces `root_tree_sha`; then

   ```rust
   let parent = branch_head(&pool, repo_id, "main").await.ok();
   let sha = commit(&pool, repo_id, "main", &root_tree_sha, parent.as_deref(),
                    "edit lib", "agent <a@x>", &paths).await?;
   ```

   `commit` stores the commit object, writes `commit_metadata`/`commit_paths`,
   and `set_ref`s `refs/heads/main → sha`. *State:* `committed' == index ==
   working_dir`.

5. **push** *(planned)*: re-puts any objects the server lacks, then
   `update_ref(repo_id, "refs/heads/main", expected_old = remembered, sha)`.
   On `RefCasFailed`, the client refuses and reports the observed tip so the
   user can pull and retry.

## 6. Tradeoffs

- **Server-resident CAS vs. local repo.** History is SQL-queryable and shared,
  but every read/write is a round-trip and the client cannot work fully offline
  (`objects-cache/` mitigates re-reads).
- **HEAD-walk over packfiles.** Simple and correct, but `O(refs × depth)`
  requests. Accepted for v1 since agent workloads are not network-bound; a pack
  negotiation is an explicit v2 option.
- **CAS ref updates, no force-push.** Concurrent pushes deterministically
  produce one winner (`RefCasFailed`); losers retry. Avoids silent overwrite at
  the cost of retry loops under contention.
- **No conflict markers.** The merge engine emits a structured dilemma rather
  than `<<<<<<<` text markers — machine-readable, but unlike Git.

## 7. Known Limitations

- **No client implemented in Rust.** `.sharp/` shadow, `index` serialization,
  `config`, `HEAD` file, local ref cache, and `objects-cache/` are all
  unimplemented. `materialize_tree` already protects `.sharp/`/`.git/`, but
  nothing writes them.
- **No CLI binary.** `init/clone/add/commit/branch/checkout/pull/push` are not
  wired up in the Rust crate; only library primitives exist.
- **No sync code.** The HEAD-walk negotiation, object streaming, and the
  `If-Match` push path live only in the TS prototype's `http.ts`; there is no
  Rust `clone`/`pull`/`push`.
- **No staging state machine in code.** Add/commit transitions are expressed by
  re-snapshotting the whole tree, not by a persisted index diffing
  `committed/index/working_dir`. There is no partial-add or `.sharpignore`
  override yet (ignore list is hardcoded in `workspace.rs`).
- **Conflict presentation is planned only.** `MERGE_DILEMMA.json` and the
  non-zero-exit summary are specified in §5.5 of the engineering plan; the Rust
  crate has the merge engine (`tier1`, `semantic_merge`) but no client writer
  for the dilemma file.
- **Algorithm split.** Native Rust objects are SHA-256; the TS prototype uses
  SHA-1. A client talking to both must be explicit about `algo` per object.
