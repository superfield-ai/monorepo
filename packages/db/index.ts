/**
 * Minimal database utilities for the studio submodule.
 *
 * The studio server uses an in-memory auth store and does not require a
 * persistent database for its core functionality. This stub provides the
 * `migrate` interface expected by `scripts/studio-start.ts` so the bootstrap
 * script can run without a full database layer.
 *
 * If a `DATABASE_URL` is set and the studio session needs persistent storage,
 * replace this stub with a full migration implementation.
 */

export interface MigrateOptions {
  databaseUrl?: string;
}

/**
 * No-op schema migration for the studio standalone mode.
 *
 * The studio server does not maintain schema-versioned tables. This function
 * is a compatibility shim so `studio-start.ts` can call `migrate()` without
 * error. If the studio server is extended with persistent storage, implement
 * schema migrations here.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function migrate(_opts?: MigrateOptions): Promise<void> {
  // No-op: studio server uses in-memory state; no schema migration required.
}
