# @superfield/db

**Status:** stub, no consumers.

This package was scaffolded for a future studio-server persistent storage
layer that has not yet been built. Today:

- `index.ts` exports a no-op `migrate()` that exists only as an interface
  shim. The original caller (`scripts/studio-start.ts`) was never created.
- `pg-container.ts` is unused — the integration tests in
  `packages/control/tests/helpers/pg-container.ts` are a separate
  implementation owned by `@superfield/control`.

If you need persistent studio storage, this is the package to grow into.
If after a quarter of cleanup passes nothing here has been adopted,
deletion is the correct call — `git rm -rf packages/db` and remove the
package from the workspace will not break any consumer.
