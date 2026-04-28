# @superfield/db

**Status:** lowdb-backed local issue store, no consumers yet.

This package owns the embedded local Superfield issue store. It starts with
lowdb because the Studio UI needs a simple, typed, file-backed source of truth
for issue state, acceptance items, test plans, and sync metadata.

- `index.ts` exports `openIssueStore()` for the embedded issue DB and a small
  compatibility `migrate()` shim.
- `pg-container.ts` is unused — the integration tests in
  `packages/control/tests/helpers/pg-container.ts` are a separate
  implementation owned by `@superfield/control`.

GitHub issues remain the synced projection for collaborators and PR linkage.
