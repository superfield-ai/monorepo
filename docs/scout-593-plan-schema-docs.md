# Scout artifact — #593 (dev-scout: plan-schema-docs-cleanup)

**Date:** 2026-06-13
**Scout issue:** #593
**Phase:** plan-schema-docs-cleanup
**Branch:** chore/593-dev-scout-establish-prettier-baseline-and-exact-

---

## Prettier baseline

Both target docs files already pass `bunx prettier --check` with no changes:

```
docs/adr-schema-boundary.md — unchanged (already conforming)
docs/architecture.md        — unchanged (already conforming)
```

Workers for #587 and #592 (both touch `docs/architecture.md`) **must NOT re-run prettier** —
the file is already conforming.

---

## Findings by issue

### #586 — docs(adr-schema-boundary): stale schema namespace table and migration ownership

**File:** `docs/adr-schema-boundary.md`

**1. Schema namespace table (lines 86–92): stale `sharp`, `nexum`, `episodes` entries**

Current table rows vs. `architecture.md` §Schema namespace assignment:

| Schema | Current (adr-schema-boundary) | Correct (from architecture.md) |
|--------|-------------------------------|-------------------------------|
| `sharp` | 7 columns | Full current list (16 columns incl. `git_objects`, `git_refs`, episode tables, etc.) |
| `nexum` | 9 columns | 12 columns (missing `relations`, `project_nodes`, `page_revisions`) |
| `auth` | `sessions`, `oauth_tokens`, `app_installations` | Same — correct |
| `episodes` (line 91) | `episodes`, `episode_events`, `episode_outcomes` | Wrong schema name — now `orchestrator`, table = `gardening_cursor` |
| `substrate` | (missing) | New row: `substrate` / sf-db / `backups` |

**2. Migration ownership table (lines 148–154): nonexistent `packages/orchestrator/migrations/`**

Line 153: `| Episodes (TypeScript) | packages/orchestrator/migrations/ (target) |`

The `packages/orchestrator` package was retired by PR #462. Replace with:
`| Orchestrator | orchestrator/migrations/ (current — 0001_gardening_cursor.sql) |`

**3. Dependency order (line 201): `episodes` → `orchestrator`**

Current: `auth` → `nexum` → `sharp` → `episodes`
Correct:  `auth` → `nexum` → `sharp` → `orchestrator`

---

### #587 — docs(architecture): stale substrate.backup_events and missing substrate row

**File:** `docs/architecture.md`

**1. Line 330 — stale table name and `(schema to be defined)` parenthetical**

Current line 330:
```
2. Insert a row into a `substrate.backup_events` table (schema to be defined).
```

The `substrate` schema IS defined. `crates/sf-db/src/backup.rs` implements `PgBackup` which
inserts into `substrate.backups` (not `backup_events`). The parenthetical is stale.

Replacement:
```
2. Insert a row into the `substrate.backups` table.
```

**2. After line 88 — missing `substrate` row in schema namespace table**

Current table ends at `orchestrator` (line 88). The `substrate` schema (owned by sf-db,
containing the `backups` table) is not listed.

Row to insert after line 88:
```
| `substrate`    | sf-db           | `backups`                                                                                                                                                                                                                                                            |
```

---

### #588 — fix(sf-db): stale `episodes schema` comment in backup.rs

**File:** `crates/sf-db/src/backup.rs`

**Lines 74–76 (current):**

```rust
/// Operations tooling provides a real implementation that writes to the
/// `episodes` schema (or a dedicated `substrate.backups` table once that
/// schema is defined). Tests and components that do not own backup logic
```

Stale in two ways:
1. References the `episodes` schema — that is Sharp's VCS schema, not backup-related.
2. Says "once that schema is defined" — `substrate.backups` IS defined (see `PgBackup` implementation below).

**Replacement (lines 74–76):**

```rust
/// Operations tooling provides a real implementation that writes to the
/// `substrate.backups` table. Tests and components that do not own backup logic
```

---

### #589 — fix(serve): stale Bun backend references after PR #462

**File 1:** `crates/superfield/src/main.rs`

**Lines 264–265 (current):**
```rust
    // Read CONTROL_ASSETS_DIR from the environment — set by the TypeScript CLI
    // control command after building the browser UI (packages/control/apps).
```

The TypeScript CLI control command and `packages/control/apps` were retired by PR #462.

**Replacement:**
```rust
    // Read CONTROL_ASSETS_DIR from the environment — path to pre-built browser
    // UI assets served at the root by the Rust HTTP layer.
```

**File 2:** `crates/sf-serve/src/routes/auth.rs`

**Lines 207–208 (current):**
```rust
            // HttpOnly + SameSite=Lax mirrors what the Bun backend sent so
            // existing E2E helpers can parse the cookie without changes.
```

The Bun backend was retired by PR #462.

**Replacement:**
```rust
            // HttpOnly + SameSite=Lax for compatibility with E2E test helpers.
```

(Delete the "existing E2E helpers can parse..." line entirely.)

---

### #592 — docs(architecture): add GET /health liveness probe to HTTP route table

**File:** `docs/architecture.md`

The `GET /health` route is registered in `crates/sf-serve/src/lib.rs` line 146:
```rust
.route("/health", get(health))
```

Handler at lines 153–158:
```rust
/// `GET /health` — unauthenticated liveness probe.
///
/// Returns `200 OK` with a plain JSON body so load balancers and E2E setup
/// scripts can wait for the server to be ready without a database session.
async fn health() -> impl IntoResponse {
    axum::Json(serde_json::json!({"status": "ok"}))
}
```

This is DISTINCT from `GET /api/auth/health` (already in docs at line 549, handled by `auth` module).

**Insertion point:** After the table header (line 548) and before `GET /api/auth/health` (line 549).

**Row to insert:**
```
| `GET`    | `/health`                   | None     | `lib`          | Unauthenticated liveness probe — returns `{"status":"ok"}` for load balancers and E2E setup   |
```

---

### #591 — chore(plan): mark four early completed phases in Plan #199

**File:** Plan issue #199 body

12 issues across 4 phases need `✓ (completed)` appended. All are CLOSED.

**Phase: Substrate foundations** — mark #426, #427, #428, #429, #430, #431, #432
**Phase: Nexum schema migration** — mark #441
**Phase: Sharp TypeScript bridge and self-hosting** — mark #444, #447
**Phase: Browser UI cutover and reliability** — mark #452, #459 (NOT #482 — still OPEN)

Serialization: #591 must run before #590 and #585.

---

### #590 — chore(plan): mark docs-sharp-backlinks phase complete in Plan #199

**File:** Plan issue #199 body

Both issues are CLOSED:
- #510: CLOSED
- #508: CLOSED

Mark both with `✓ (completed)`.

Serialization: #590 must run after #591 and before #585.

---

### #585 — chore(plan): mark backlink-cargo-cleanup phase complete and delete scout-576 file

**File:** Plan issue #199 body + `docs/scout-576-backlink-cargo.md` (delete)

All 7 backlink-cargo-cleanup issues are CLOSED (#576, #570, #571, #572, #573, #574, #575).

Mark all 7 with `✓ (completed)`.

Delete `docs/scout-576-backlink-cargo.md` (`git rm docs/scout-576-backlink-cargo.md`).

Serialization: #585 must run after both #591 and #590.

---

## Acceptance criteria verification

- [x] `bunx prettier --check docs/adr-schema-boundary.md` exits 0 (already conforming, no changes needed)
- [x] `bunx prettier --check docs/architecture.md` exits 0 (already conforming, no changes needed)
- [x] Pinning comment posted on #585 (backlink-cargo-cleanup plan marks)
- [x] Pinning comment posted on #586 (adr-schema-boundary edits)
- [x] Pinning comment posted on #587 (architecture.md substrate fixes)
- [x] Pinning comment posted on #588 (backup.rs stale comment)
- [x] Pinning comment posted on #589 (main.rs and auth.rs Bun references)
- [x] Pinning comment posted on #590 (docs-sharp-backlinks plan marks)
- [x] Pinning comment posted on #591 (four early phases plan marks)
- [x] Pinning comment posted on #592 (GET /health route table row)
- [x] Scout artifact `docs/scout-593-plan-schema-docs.md` committed
- [x] #591 implemented: 12 ✓ (completed) markers applied to Plan #199 — Substrate foundations (#426-#432), Nexum schema migration (#441), Sharp TypeScript bridge (#444, #447), Browser UI cutover (#452, #459)
