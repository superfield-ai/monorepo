# Scout 558 — adr-routes-cleanup: Exact Edit Targets

**Phase:** adr-routes-cleanup  
**Scout issue:** #558  
**Date:** 2026-06-13  
**Prettier baseline:** `docs/adr-embedding-model.md` and `docs/architecture.md` already pass
`bunx prettier --check` with no changes required.

---

## Issue #554 — Fix `sf-embed` references in `docs/adr-embedding-model.md`

Four references to the retired `crates/sf-embed` crate must be updated to
`crates/nexum/src/embed.rs`.

| #   | Line | Current text                                                                                                             | Replacement text                                                                         |
| --- | ---- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| 1   | 6    | `crates/sf-embed`                                                                                                        | `crates/nexum/src/embed.rs`                                                              |
| 2   | 88   | `### Rust (\`crates/sf-embed\`)`                                                                                         | `### Rust (\`crates/nexum/src/embed.rs\`)`                                               |
| 3   | 135  | `` `-- embedding model: Xenova/all-MiniLM-L6-v2 (Rust: sentence-transformers/all-MiniLM-L6-v2), rev c9745ed, 384-dim` `` | _(keep as-is — this is the comment template for new SQL columns, not a crate reference)_ |
| 4   | 145  | ``The `sf-embed` Rust crate is the canonical implementation``                                                            | ``The `crates/nexum/src/embed.rs` module is the canonical implementation``               |

**Note on line 135:** The vector column comment template on line 135 uses
`Xenova/all-MiniLM-L6-v2` as a model name string (not a crate reference); it
does not need updating for this issue.

**Actual four `sf-embed` references:**

1. **Line 6** — `Related:` field in the header block:

   ```
   **Related:** architecture.md §Governed Embedding Standard, `crates/sf-embed`, `packages/db/index.ts`
   ```

   → Replace `` `crates/sf-embed` `` with `` `crates/nexum/src/embed.rs` ``

2. **Line 88** — Governance constants section heading:

   ```
   ### Rust (`crates/sf-embed`)
   ```

   → Replace with `### Rust (\`crates/nexum/src/embed.rs\`)`

3. **Line 135** — Vector column comment template uses `Xenova/` (model name, not crate path):

   ```
   3. Include the comment `-- embedding model: Xenova/all-MiniLM-L6-v2 (Rust: sentence-transformers/all-MiniLM-L6-v2), rev c9745ed, 384-dim`.
   ```

   → This line references the model by its HuggingFace identifier (`Xenova/`),
   not the Rust crate. Issue #554 instructions say "4 spots referencing
   `crates/sf-embed`" — this line's `Xenova/` is the model ID, not the crate
   name. **Do not change line 135** in the context of #554.

4. **Line 145** — Consequences paragraph:
   ```
   - The `sf-embed` Rust crate is the canonical implementation for Rust consumers;
   ```
   → Replace ``The `sf-embed` Rust crate`` with ``The `crates/nexum/src/embed.rs` module``

**Canonical target:** `crates/nexum/src/embed.rs` (exists; exports `GOVERNED_MODEL`,
`GOVERNED_MODEL_REVISION`, `GOVERNED_DIM`).

---

## Issue #555 — Fix broken SQL join in `§Cross-component joins`

**File:** `docs/architecture.md`  
**Section:** `### Table naming convention` (appears before `### Cross-component joins`)  
**Lines:** 96–104 (the first SQL code block)

**Current broken query (lines 96–104):**

```sql
-- Correct: qualified reference from an orchestrator query
SELECT e.id, b.content
FROM   orchestrator.gardening_cursor   e
JOIN   nexum.blocks                    b ON b.id = e.workspace_id;
```

**Why it is broken:**

- `orchestrator.gardening_cursor` columns: `workspace_id UUID`, `step_name TEXT`,
  `cursor_token TEXT`, `updated_at TIMESTAMPTZ`. There is no column that holds a
  `nexum.blocks.id`.
- `nexum.blocks.id` is a block-level UUID. `e.workspace_id` is a workspace-level
  UUID. Joining them is a semantic UUID type mismatch — these are foreign keys to
  entirely different entities.
- The `cursor_token TEXT` field is described as "opaque continuation token
  (e.g. a Nexum document_version UUID or an ISO-8601 timestamp string)" — it is
  TEXT, not UUID, and when it holds a block-related value it refers to a
  `document_version` UUID, not a block UUID.

**Correct join condition:**

`orchestrator.gardening_cursor` has no natural FK to `nexum.blocks`. The table
purpose is tracking _per-workspace loop state_, not linking to individual blocks.
The correct cross-component example should join on `workspace_id`, which IS shared
across schemas (all component tables carry `workspace_id` as a tenant scoping FK to
`public.workspaces`). For example:

```sql
-- Correct: qualified reference from an orchestrator query
-- (joining by shared workspace_id tenant scope)
SELECT e.step_name, e.cursor_token, e.updated_at
FROM   orchestrator.gardening_cursor   e
JOIN   public.workspaces               w  ON w.id = e.workspace_id;
```

Alternatively, if the intent is to demonstrate a Nexum join, use the
`nexum.page_revisions` table which also has `workspace_id`:

```sql
SELECT e.step_name, pr.page_name, pr.content
FROM   orchestrator.gardening_cursor   e
JOIN   nexum.page_revisions            pr ON pr.workspace_id = e.workspace_id
ORDER  BY pr.ingested_at DESC;
```

**Exact location of the bug:**

- File: `docs/architecture.md`
- Lines 96–104 (the first SQL code block, the "Correct" example under
  `### Table naming convention`)
- Line 100 specifically: `JOIN   nexum.blocks                    b ON b.id = e.workspace_id;`

---

## Issue #556 — Add `technical` to `/pages/{name}` description in HTTP route table

**File:** `docs/architecture.md`  
**Line:** 557

**Current text (line 557):**

```
| `GET`    | `/pages/{name}`             | None     | `pages`        | Named knowledge-base page as markdown (`prd`, `architecture`, `plan`, `strategy`) |
```

**Corrected text:**

```
| `GET`    | `/pages/{name}`             | None     | `pages`        | Named knowledge-base page as markdown (`prd`, `architecture`, `plan`, `strategy`, `technical`) |
```

**Evidence that `technical` is a valid page name:**

- Line 478 of `docs/architecture.md` lists `TechnicalResearch` producing a
  `technical` page revision.
- Lines 624–632 of `docs/architecture.md` show the known-pages registry:
  `technical` maps to `nexum.page_revisions` for page name `technical`.

---

## Issue #557 — Neutralize stale `nexum.documents` claim in `pages.rs`

**File:** `crates/sf-serve/src/routes/pages.rs`  
**Line:** 16–17

**Current text (lines 15–17):**

```rust
//! The `/pages/project` route is registered first (more specific) and uses
//! [`sf_db::fetch_project_page`] — a recursive CTE traversal over the project
//! node graph — rather than the `nexum.documents` document model used by the
//! other page routes.
```

**Problem:** The comment claims the other page routes (`/pages/{name}`) use
`nexum.documents`. This is stale. As of the page-revision architecture, those
routes use `sf_db::fetch_page_content` against `nexum.page_revisions` (not
`nexum.documents`). Issue #547 tracks the implementation gap.

**Neutral replacement wording:**

```rust
//! The `/pages/project` route is registered first (more specific) and uses
//! [`sf_db::fetch_project_page`] — a recursive CTE traversal over the project
//! node graph — rather than the page-revision query used by the other page
//! routes (see `sf_db::fetch_page_content` and `nexum.page_revisions`; the
//! `nexum.documents` backing is tracked in issue #547).
```

This wording:

- Removes the false claim that `nexum.documents` is the current implementation.
- Acknowledges the implementation gap tracked by #547 without asserting which
  table is correct.
- Directs readers to `nexum.page_revisions` which is the designed target per
  architecture.md §Page revision schema.

---

## Prettier baseline status

Both docs files are already Prettier-compliant; no baseline diff was committed.

```
$ bunx prettier --check docs/adr-embedding-model.md docs/architecture.md
Checking formatting...
All matched files use Prettier code style!
```

Workers must **NOT** re-run `bunx prettier --write` on `docs/adr-embedding-model.md`
or `docs/architecture.md` — the baseline is already clean and re-running would
produce no diff but risks inadvertent whitespace changes.
