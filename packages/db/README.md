# @superfield/db

**Status:** lowdb-backed local issue store + PostgreSQL RLS infrastructure.

This package owns the embedded local Superfield issue store and the
PostgreSQL row-level security (RLS) session context wiring.

- `index.ts` exports `openIssueStore()` / `openWorkspaceIssueStore()` for the
  embedded issue DB and a compatibility `migrate()` shim.
- `rls.ts` exports `setWorkspaceContext`, `clearWorkspaceContext`,
  `getWorkspaceContext`, and `withWorkspaceTransaction` — helpers for scoping
  a PostgreSQL connection to a workspace via the `app.workspace_id` session
  variable used by RLS policies.
- `migrations/0001_rls_workspace_isolation.sql` is the stub migration that
  enables RLS and installs per-operation `PERMISSIVE` policies on all
  workspace-keyed tables across the `sharp`, `nexum`, `episodes`, and `auth`
  schemas.  Tables that do not yet exist are skipped gracefully.
- `pg-container.ts` is the shared Postgres Docker helper; re-exported by
  `packages/control/tests/helpers/pg-container.ts`.

GitHub issues remain the synced projection for collaborators and PR linkage.
