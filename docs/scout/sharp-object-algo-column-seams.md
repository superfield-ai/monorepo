# Dev-Scout Findings: Sharp object-storage read/write seams for the per-object `algo` column

**Issue:** #750 (scout) — gates #725 (implementation)
**Phase:** sharp-hash-algo
**Scout date:** 2026-06-23
**Canonical docs:** `crates/sharp/docs/whitepaper.md` §4.0 / §4.1; `crates/sharp/docs/postgres-storage-plugin.md` §`objects`
**Downstream issues:** #725 (add the `algo` column, default, and CHECK constraint to `sharp.objects`)

This is a **stub-only / documentation** pass. It introduces **no** change to
object persistence behaviour. `cargo build -p sharp` and `cargo test -p sharp`
pass unchanged. The actual column + default + CHECK constraint, and threading
the algorithm through the call sites below, are issue #725.

---

## 1. What the whitepaper requires

Whitepaper §4.0 (Content-Addressing Hash) and §4.1 (Core Objects) record the
hash algorithm **per object** via an `algo` column on the object store:

| Field  | Meaning                                                          |
| ------ | ---------------------------------------------------------------- |
| `algo` | Which hash produced the id: `sha1` (default) or `sha256` (§4.0). |

The product rationale: Sharp's object IDs _are_ Git's object IDs. Git defaults to
SHA-1 (with SHA-1DC collision detection) and supports SHA-256 behind
`objectformat=sha256`. To support mixed-algorithm repos during the SHA-1 →
SHA-256 transition, every stored object must record which algorithm produced its
id. The concrete Postgres realization (`crates/sharp/docs/postgres-storage-plugin.md`
§`objects`) specifies:

> `algo` `text` — Default `sha1`; constrained to `sha1` or `sha256` (§4.0).
> Index: a composite over `(algo, id)` so SHA-1 ↔ SHA-256 mixed repos still plan cleanly.

---

## 2. Current `sharp.objects` schema (as deployed)

From `crates/sharp/migrations/0001_sharp_vcs_schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS sharp.objects (
    sha256      TEXT        PRIMARY KEY,   -- hex-encoded SHA-256 of content
    repo_id     UUID        NOT NULL REFERENCES sharp.repos(id) ON DELETE CASCADE,
    object_type TEXT        NOT NULL CHECK (object_type IN ('blob', 'tree', 'commit')),
    size_bytes  BIGINT      NOT NULL,
    data        BYTEA       NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS objects_repo_id_idx ON sharp.objects (repo_id);
```

Gaps vs. the whitepaper/plugin spec:

- **No `algo` column.** The PK column is literally named `sha256` and the only
  hash currently emitted by callers is SHA-256 (see §3). There is no record of
  which algorithm produced a given id.
- The PK column name `sha256` is a misnomer once SHA-1 ids can be stored. The
  scout does **not** rename it (high-blast-radius; out of scope). #725 should
  add `algo` alongside the existing `sha256` PK and leave the column name as-is,
  or rename in a later dedicated migration. The plugin doc names the logical
  column `id`; the deployed column is `sha256` — these are the same column.
- Other tables (`refs.target_sha`, `commit_metadata.commit_sha`/`parent_sha`,
  `commit_paths.commit_sha`/`blob_sha`) carry **FK references to
  `sharp.objects(sha256)`** but no algorithm of their own. They inherit the
  algorithm of the row they point at; #725 does **not** need to touch them.

---

## 3. Object read/write call-site map

Every site that writes or reads an object id, grouped by the writer/reader API
in `crates/sharp/src/object.rs`. The two writer functions are the only places
the algorithm must be **supplied**; readers key by id and inherit the stored
algorithm.

### 3a. Writers (must carry the per-object algorithm — #725)

| Site                            | Function                  | Algorithm today                           | Notes for #725                                                                                                                                                                                                                                                                                                            |
| ------------------------------- | ------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `crates/sharp/src/object.rs:50` | `object::store`           | SHA-256 (raw bytes, `sha256_hex`)         | The `INSERT INTO sharp.objects (...)` at line 62 omits `algo`; must add it. The id is the raw-bytes SHA-256 (`sha256_hex`, line 34).                                                                                                                                                                                      |
| `crates/sharp/src/object.rs:95` | `object::store_canonical` | `HashAlgo::Sha256` (hard-coded, line 101) | `id_hex(hash_object(kind, payload, HashAlgo::Sha256))` — the git-canonical, header-prefixed id. The `INSERT` at line 112 omits `algo`. This is the site that, in a real `objectformat=sha256`/SHA-1 world, must thread the repo's `HashAlgo`. `HashAlgo` already exists in `crates/sharp/src/git_canonical.rs:63` (`Sha1` | `Sha256`); #725 / a later issue can pass it in instead of the hard-coded `Sha256`. |

`store` callers (raw-bytes SHA-256 path):

- `crates/sharp/src/commit.rs:71` — `object::store(.., ObjectType::Commit, &data)`
- `crates/sharp/src/projections.rs:370` — `object::store(.., ObjectType::Blob, content.as_bytes())`
- `crates/sharp/src/projections.rs:383` — `object::store(.., ObjectType::Commit, &data)`
- `crates/sharp/src/episode.rs:514` — `object::store(.., ObjectType::Blob, data)` (episode artifact CAS)
- `crates/sharp/tests/integration.rs:141,153,180` — test writes (blob/tree/blob)

`store_canonical` callers (git-canonical-id path):

- `crates/sharp/src/workspace.rs:122` — blob (snapshot)
- `crates/sharp/src/workspace.rs:132` — blob (snapshot, symlink branch)
- `crates/sharp/src/workspace.rs:256` — tree (build-tree)

### 3b. Readers (key by id; inherit stored algorithm — no change needed for #725)

| Site                                    | Function       | Notes                                                                                                                                                             |
| --------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crates/sharp/src/object.rs:132`        | `object::load` | `SELECT data FROM sharp.objects WHERE sha256 = $1`. Keys by id only; does not need `algo`. (#725 may optionally `SELECT algo` to verify, but it is not required.) |
| `crates/sharp/src/workspace.rs:313`     | `object::load` | materialize: read root tree                                                                                                                                       |
| `crates/sharp/src/workspace.rs:325,338` | `object::load` | materialize: read blob (file / symlink)                                                                                                                           |
| `crates/sharp/src/projections.rs:300`   | `object::load` | read blob for projection                                                                                                                                          |

### 3c. Two id models share the table (pre-existing, documented)

`object.rs` already documents (lines 78–88) that `store` keys on the raw-bytes
SHA-256 while `store_canonical` keys on the header-prefixed git-canonical id.
Both are SHA-256 today, both live in `sharp.objects`, addressing different rows.
The `algo` column does **not** distinguish these two id _models_ — it records the
hash _function_ (`sha1` vs `sha256`). Both current models are `sha256`, so #725's
default-`sha1`-but-write-`sha256` choice must be deliberate (see §4, note B).

---

## 4. Migration strategy decision

**Decision: land the `algo` column as a NEW additive migration
`crates/sharp/migrations/0010_sharp_objects_algo.sql` (issue #725). Do NOT edit
the deployed `0001_sharp_vcs_schema.sql`.**

Rationale — this is forced by the migration runner contract, not a style choice:

- The runner (`crates/sf-db/src/migrate.rs`, mirrored by
  `packages/db/migrator.ts`) records each applied file's id in a
  `schema_migrations` tracking table and **applies only pending files**.
  Migration `0001` is already recorded as applied on every existing database.
- Editing `0001` would therefore **never re-run** on a deployed database — the
  `algo` column would silently never appear where it matters, while appearing
  only on fresh databases. That is exactly the "schema applied inconsistently"
  failure the scout exists to prevent.
- Adding a new `0010_*.sql` is the **established pattern** in this crate: `0005_sharp_refs_model.sql`
  already alters the `0001` `sharp.refs` table with `ALTER TABLE sharp.refs ...`
  in a separate additive file rather than editing `0001`. The same approach
  applies to `sharp.objects`.

Concrete shape for #725 (`0010_sharp_objects_algo.sql`), kept idempotent per the
runner's idempotency contract:

```sql
-- Per-object hash algorithm (whitepaper §4.0/§4.1). Additive; do not edit 0001.
ALTER TABLE sharp.objects
    ADD COLUMN IF NOT EXISTS algo TEXT NOT NULL DEFAULT 'sha1';

-- Constrain to the two supported algorithms (§4.0). Guard against re-run.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'objects_algo_check'
    ) THEN
        ALTER TABLE sharp.objects
            ADD CONSTRAINT objects_algo_check CHECK (algo IN ('sha1', 'sha256'));
    END IF;
END$$;

-- Composite (algo, id) index so mixed SHA-1/SHA-256 repos plan cleanly
-- (postgres-storage-plugin.md §objects).
CREATE INDEX IF NOT EXISTS objects_algo_sha256_idx ON sharp.objects (algo, sha256);
```

Notes for #725 (handoff):

- **Note A — default vs. emitted algorithm.** The spec default is `sha1`
  (matches `git init` and what new GitHub repos use). But every current writer
  (§3a) emits a **SHA-256** id (`sha256_hex` / `HashAlgo::Sha256`). So a plain
  `DEFAULT 'sha1'` would mislabel every existing row and every row written by the
  un-migrated call sites. #725 must EITHER backfill existing rows to `'sha256'`
  and have the writers pass `'sha256'` explicitly until the SHA-1 path is
  plumbed, OR set the column default to `'sha256'` to match today's reality and
  introduce `'sha1'` only when `objectformat` init plumbing lands (that init
  plumbing is explicitly out of scope here — see #750 scope). The whitepaper
  default is `sha1`; reconciling that with the SHA-256-only writers is the key
  decision #725 must make. Recommended: backfill `'sha256'` for the existing
  rows and have `store`/`store_canonical` write `'sha256'` until repo-level
  `objectformat` selection exists.
- **Note B — thread `HashAlgo` into `store_canonical`.** Line 101 hard-codes
  `HashAlgo::Sha256`. When repo-level `objectformat=sha256` plumbing arrives
  (out of scope for this phase), this becomes a parameter; the `algo` column
  value must equal the `HashAlgo` used to compute the id. For #725, writing a
  constant that matches the hard-coded `Sha256` is correct and sufficient.
- **Note C — readers need no change.** §3b readers key by id; the FK-bearing
  tables (refs/commit_metadata/commit_paths) inherit the object's algorithm.

---

## 5. Verification (this scout)

- `cargo build -p sharp` exits 0 — no source change to object persistence.
- `cargo test -p sharp` passes unchanged (2 passed, DB-gated tests `#[ignore]`d
  as before).
- This report contains the string `algo` and records the chosen migration
  strategy (new additive migration `0010_sharp_objects_algo.sql`).
