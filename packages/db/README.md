# @superfield/db

**Status:** lowdb-backed local issue store + PostgreSQL RLS infrastructure + Nexum schema migration.

This package owns the embedded local Superfield issue store, the
PostgreSQL row-level security (RLS) session context wiring, and the Nexum
schema migration tooling.

- `index.ts` exports `openIssueStore()` / `openWorkspaceIssueStore()` for the
  embedded issue DB and a compatibility `migrate()` shim.
- `rls.ts` exports `setWorkspaceContext`, `clearWorkspaceContext`,
  `getWorkspaceContext`, and `withWorkspaceTransaction` — helpers for scoping
  a PostgreSQL connection to a workspace via the `app.workspace_id` session
  variable used by RLS policies.
- `migrations/0001_rls_workspace_isolation.sql` is the stub migration that
  enables RLS and installs per-operation `PERMISSIVE` policies on all
  workspace-keyed tables across the `sharp`, `nexum`, `episodes`, and `auth`
  schemas. Tables that do not yet exist are skipped gracefully.
- `nexum-migration.ts` exports `runNexumSchemaMigration` (applies
  `migrations/nexum/*.sql` to the shared instance) and `runNexumDataCutover`
  (migrates rows from a `staging_nexum` schema into `nexum.*` under a given
  `workspaceKey`). Both are idempotent.
- `migrations/nexum/0001__nexum_schema.sql` — creates the `nexum` schema and all
  tables with `workspace_key` columns. Requires `pgvector/pgvector:pg16` for the
  `vector` extension (dimension 384, governed by issue #360).
- `migrations/nexum/0002__nexum_data_cutover.sql` — reference document for the
  cutover queries executed by `runNexumDataCutover`. Not applied by the runner.
- `pg-container.ts` is the shared Postgres Docker helper (`postgres:16` image).
  Integration tests that require the `vector` extension start `pgvector/pgvector:pg16`
  directly (see `tests/integration/nexum-migration.integration.test.ts`).

## Nexum migration — dev setup

The standalone `nexum-pg` Docker Compose service has been removed. All Nexum
data lives in the shared Postgres instance (`pgvector/pgvector:pg16`, port 5432).

**Start the shared Postgres and apply all migrations (includes nexum schema):**

```bash
docker compose up -d db
docker compose run --rm migrate
```

**One-shot data cutover from a standalone nexum-pg source:**

Restore the standalone Nexum DB into a `staging_nexum` schema on the shared
instance, then call `runNexumDataCutover` with a `workspaceKey`:

```bash
# Step 1: dump data from old nexum-pg and restore into staging schema
pg_dump postgresql://nexum:nexum@localhost:5434/nexum \
  | psql postgresql://superfield:superfield@localhost:5432/superfield

# Step 2: rename the restored public schema to staging_nexum
psql postgresql://superfield:superfield@localhost:5432/superfield \
  -c "ALTER SCHEMA public RENAME TO staging_nexum; CREATE SCHEMA public;"

# Step 3: run the TypeScript cutover
DATABASE_URL=postgresql://superfield:superfield@localhost:5432/superfield \
  bun packages/db/nexum-migration-cli.ts --workspace-key ws-default
```

(The CLI wrapper `nexum-migration-cli.ts` is a thin entry point that wires
`runNexumDataCutover` to a real `pg.Pool` executor.)

**Run Nexum integration tests (requires Docker):**

```bash
npx vitest run packages/db/tests/integration/nexum-migration.integration.test.ts
```

GitHub issues remain the synced projection for collaborators and PR linkage.
