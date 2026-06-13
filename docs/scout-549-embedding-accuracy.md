# Scout 549 — Embedding Accuracy Fixes: Exact Edit Targets

**Phase:** embedding-accuracy-fixes  
**Scout issue:** #549  
**Downstream issues:** #545 (stale §Governed Embedding Standard + page-revision DDL), #546 (GOVERNED_MODEL_REVISION pinning), #548 (missing sf-db row in §Migration ownership table)

---

## Prettier baseline

`bunx prettier --write docs/architecture.md` — **no diff produced** (file already Prettier-clean). Workers must NOT re-run prettier on `docs/architecture.md`.

---

## Issue #545 — Fix stale §Governed Embedding Standard Model row, migration comment, and page-revision DDL

### Finding 1: Model row still says `Xenova/all-MiniLM-L6-v2`

**File:** `docs/architecture.md`

| Location                                      | Line | Current text                                                                                                                                                                                             |
| --------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §Governed Embedding Standard — Standard table | 180  | `\| **Model**      \| \`Xenova/all-MiniLM-L6-v2\` \|`                                                                                                                                                    |
| §Rationale bullet                             | 190  | `- Nexum has shipped \`blocks.embedding vector(384)\` with \`Xenova/all-MiniLM-L6-v2\` as its production embedding layer. Standardising on the existing implementation avoids a re-embedding migration.` |
| §Adoption rule for new stores bullet 3        | 221  | `3. Reference the governed model in a migration comment: \`-- embedding model: Xenova/all-MiniLM-L6-v2, 384-dim\`.`                                                                                      |

The governed Rust runtime uses `sentence-transformers/all-MiniLM-L6-v2` (safetensors, via `hf-hub` + `candle`). The `Xenova/all-MiniLM-L6-v2` identifier is the ONNX/TypeScript variant and is no longer the runtime in use. Per `docs/adr-embedding-model.md` line 31–33 and `models/embedding.lock` line 18, the Rust model ID is `sentence-transformers/all-MiniLM-L6-v2` with revision `c9745ed`.

**Correct Model row value:** `sentence-transformers/all-MiniLM-L6-v2` (safetensors, HF Hub, via `hf-hub` + `candle`)

### Finding 2: Page-revision DDL subsection has stale DDL (§Nexum — Company Knowledge Graph, lines 40–50)

**File:** `docs/architecture.md`, lines 39–50

Current DDL in the doc:

```sql
CREATE TABLE IF NOT EXISTS nexum.page_revisions (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID        NOT NULL,   -- tenant UUID (per-workspace RLS context)
    page_name    TEXT        NOT NULL,   -- human-readable page identifier
    content      TEXT        NOT NULL,   -- rendered Markdown / plain-text content
    provenance   TEXT        NOT NULL,   -- free-text provenance tag (URL or agent ID)
    ingested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS page_revisions_workspace_page_idx
    ON nexum.page_revisions (workspace_id, page_name, ingested_at DESC);
```

Actual DDL in `crates/nexum/migrations/0003_page_revisions.sql` (lines 39–50):

```sql
CREATE TABLE IF NOT EXISTS nexum.page_revisions (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID        NOT NULL REFERENCES public.workspaces(id),
    page_name    TEXT        NOT NULL,
    content      TEXT        NOT NULL,
    provenance   TEXT        NOT NULL DEFAULT '',
    ingested_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for reading latest revision by (workspace_id, page_name).
CREATE INDEX IF NOT EXISTS page_revisions_workspace_page_idx
    ON nexum.page_revisions (workspace_id, page_name, ingested_at DESC);
```

**Differences:**

| Column/detail           | In architecture.md (stale)  | In 0003_page_revisions.sql (canonical)      |
| ----------------------- | --------------------------- | ------------------------------------------- |
| `workspace_id`          | `NOT NULL` with no FK       | `NOT NULL REFERENCES public.workspaces(id)` |
| `provenance`            | `NOT NULL` with no DEFAULT  | `NOT NULL DEFAULT ''`                       |
| `ingested_at` DEFAULT   | `DEFAULT NOW()` (uppercase) | `DEFAULT now()` (lowercase)                 |
| Inline comments         | Yes (verbose)               | No inline comments                          |
| Blank line before index | No                          | Yes                                         |

There is also a **duplicate** page-revision DDL section at the bottom of `docs/architecture.md` (§Nexum — Page Revision Schema, lines 636–668). That section's DDL (lines 643–653) matches the canonical migration exactly and is already correct. The stale DDL is only in the early §Nexum subsection (lines 39–50).

---

## Issue #546 — Enforce GOVERNED_MODEL_REVISION pinning in crates/nexum/src/embed.rs

**File:** `crates/nexum/src/embed.rs`

### Finding 1: `Repo::new()` used instead of `Repo::with_revision()`

**Line 136:**

```rust
let repo = api.repo(Repo::new(GOVERNED_MODEL.to_string(), RepoType::Model));
```

`Repo::new()` fetches the default (latest) revision from HuggingFace Hub. The governed revision `c9745ed` is not pinned, so a future HF Hub update could silently change the model weights used at runtime.

**Fix:** Replace with `Repo::with_revision(GOVERNED_MODEL.to_string(), RepoType::Model, GOVERNED_MODEL_REVISION.to_string())`.

### Finding 2: `GOVERNED_MODEL_REVISION` constant is missing

The file defines `GOVERNED_MODEL` (line 32) and `GOVERNED_DIM` (line 39) but has no `GOVERNED_MODEL_REVISION` constant. It should be added in the `// ── Governance constants ──` block (after line 29, alongside `GOVERNED_MODEL`).

**Correct revision hash:** `c9745ed`  
Source: `models/embedding.lock` line 25 (`revision = "c9745ed"`) and `docs/adr-embedding-model.md` line 33 (`**HF revision**: \`c9745ed\``).

**Suggested constant (insert after line 32):**

```rust
/// Pinned HuggingFace Hub revision (git commit SHA) for the governed embedding model.
///
/// Locked at `models/embedding.lock`. Changing this constant requires a corpus
/// re-embedding pass and a schema migration — treat as a major breaking change.
pub const GOVERNED_MODEL_REVISION: &str = "c9745ed";
```

---

## Issue #548 — Add missing sf-db row to §Migration ownership table

**File:** `docs/architecture.md`

### §Migration ownership table (lines 104–113)

Current table (lines 108–113):

```markdown
| Component    | Migration path                                                     |
| ------------ | ------------------------------------------------------------------ |
| Sharp        | `crates/sharp/migrations/`                                         |
| Nexum        | `crates/nexum/migrations/`                                         |
| Auth         | `crates/sf-auth/src/migrations/` (Rust crate)                      |
| Orchestrator | `orchestrator/migrations/` (current — `0001_gardening_cursor.sql`) |
```

The `sf-db` crate is missing. `crates/sf-db/migrations/` contains:

- `0001_workspaces.sql`
- `0002_substrate_backups.sql`
- `0003_workspace_id_threading.sql`

All three files are confirmed present. The `sf-db` row should be inserted as the **first row** of the table body (before Sharp), since `sf-db` is the foundational schema (nexum's `0003_page_revisions.sql` explicitly depends on `crates/sf-db/migrations/0001_workspaces.sql`).

**Row to insert at line 110** (between the header separator and the Sharp row):

```markdown
| sf-db | `crates/sf-db/migrations/` |
```

Full table after fix:

```markdown
| Component    | Migration path                                                     |
| ------------ | ------------------------------------------------------------------ |
| sf-db        | `crates/sf-db/migrations/`                                         |
| Sharp        | `crates/sharp/migrations/`                                         |
| Nexum        | `crates/nexum/migrations/`                                         |
| Auth         | `crates/sf-auth/src/migrations/` (Rust crate)                      |
| Orchestrator | `orchestrator/migrations/` (current — `0001_gardening_cursor.sql`) |
```

---

## Key files read

| File                                              | Purpose                                                                                         |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `docs/architecture.md`                            | Primary edit target — all three issues                                                          |
| `crates/nexum/src/embed.rs`                       | `Repo::new()` at line 136; missing `GOVERNED_MODEL_REVISION`                                    |
| `crates/nexum/migrations/0003_page_revisions.sql` | Canonical DDL for comparison                                                                    |
| `models/embedding.lock`                           | Pinned revision `c9745ed`                                                                       |
| `docs/adr-embedding-model.md`                     | Confirms revision `c9745ed`                                                                     |
| `crates/sf-db/migrations/`                        | Confirms `0001_workspaces.sql`, `0002_substrate_backups.sql`, `0003_workspace_id_threading.sql` |
