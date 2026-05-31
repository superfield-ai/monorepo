/**
 * @file migrator.ts
 *
 * Unified migration runner for the single Postgres instance.
 *
 * Canonical reference: docs/architecture.md §Data Layer
 *
 * # Design
 *
 * Migration files live in packages/db/migrations/NNN_description.ts. Each
 * exports:
 *   - id       — unique string identifying the migration (e.g. "0001_initial_graph")
 *   - preCheck — verify the DB is in the expected state before applying
 *   - up       — idempotent DDL or DML to apply
 *   - postCheck — verify the migration had the intended effect
 *
 * The runner:
 *   1. Connects to the Postgres instance via DATABASE_URL.
 *   2. Creates schema_migrations table if it does not exist.
 *   3. Reads applied migration IDs from schema_migrations.
 *   4. For each pending migration (in numeric file order): preCheck, up,
 *      postCheck, then records the migration as applied.
 *   5. Exits non-zero on any failure. A failed postCheck leaves the migration
 *      unrecorded so it can be retried after a fix.
 *
 * # Usage
 *
 *   DATABASE_URL=postgres://... bun packages/db/migrator.ts
 *
 * The migrator is a standalone program. It is NOT imported by the application
 * server. In production it runs as a k8s Job before the rolling app update.
 *
 * # Blueprint rules implemented
 *
 * - three-layer-schema-model (line 1383): this file is Layer 2 (idempotent
 *   DDL at startup) and Layer 3 (versioned checked migrations as a standalone
 *   program).
 * - versioned-migration-files (line 1391): migration files, schema_migrations
 *   table, preCheck/up/postCheck contract.
 * - no-startup-structural-migration (line 1663): this runner is never imported
 *   into the application startup path.
 */

import postgres from "postgres";
import { getMigrations } from "./migrations/index.ts";

/** SQL helper type passed to migration callbacks. */
export type Sql = ReturnType<typeof postgres>;

/** Contract every migration file must satisfy. */
export interface Migration {
  /**
   * Stable unique identifier for this migration. Must match the filename
   * prefix so the runner can correlate recorded vs pending.
   * Example: "0001_initial_graph"
   */
  id: string;

  /**
   * Verify the database is in the expected state before applying the
   * migration. Throw an Error if the precondition is not satisfied.
   */
  preCheck(sql: Sql): Promise<void>;

  /**
   * Apply the migration. Must be fully idempotent — repeated application
   * must produce the same result and never error.
   */
  up(sql: Sql): Promise<void>;

  /**
   * Verify the migration had the intended effect. Throw an Error if the
   * post-condition is not satisfied. A failure here leaves the migration
   * unrecorded so it can be retried after a fix.
   */
  postCheck(sql: Sql): Promise<void>;
}

/** Options accepted by runMigrations. */
export interface RunMigrationsOptions {
  /** Postgres connection URL. Defaults to DATABASE_URL env var. */
  databaseUrl?: string;
  /** Override the migration list (useful in tests). */
  migrations?: Migration[];
  /** Receive log lines (defaults to console.log). */
  log?: (message: string) => void;
}

/**
 * Run all pending migrations against the target Postgres instance in order.
 *
 * Idempotent: already-applied migrations are skipped. Returns the list of
 * migration IDs that were applied in this run.
 */
export async function runMigrations(
  opts: RunMigrationsOptions = {},
): Promise<string[]> {
  const {
    databaseUrl = process.env.DATABASE_URL,
    migrations = getMigrations(),
    log = (msg: string) => console.log(msg),
  } = opts;

  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. Pass databaseUrl or set the environment variable.",
    );
  }

  const sql = postgres(databaseUrl, { max: 1 });

  try {
    // Ensure the migration tracking table exists.
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id          TEXT        PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;

    // Fetch already-applied migration IDs.
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM schema_migrations ORDER BY applied_at
    `;
    const applied = new Set(rows.map((r) => r.id));

    const pending = migrations.filter((m) => !applied.has(m.id));
    const appliedIds: string[] = [];

    for (const migration of pending) {
      log(`[migrator] running migration: ${migration.id}`);

      // preCheck — verify prerequisites.
      await migration.preCheck(sql);

      // up — apply the migration.
      await migration.up(sql);

      // postCheck — verify the effect.
      await migration.postCheck(sql);

      // Record the migration as applied only after a successful postCheck.
      await sql`
        INSERT INTO schema_migrations (id) VALUES (${migration.id})
        ON CONFLICT (id) DO NOTHING
      `;

      log(`[migrator] applied: ${migration.id}`);
      appliedIds.push(migration.id);
    }

    if (pending.length === 0) {
      log("[migrator] no pending migrations");
    } else {
      log(`[migrator] applied ${appliedIds.length} migration(s)`);
    }

    return appliedIds;
  } finally {
    await sql.end();
  }
}

// When executed directly as a script: run migrations and exit.
// In Bun, `import.meta.main` is true when the file is the entry point.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if ((import.meta as any).main) {
  runMigrations()
    .then((applied) => {
      if (applied.length > 0) {
        console.log(`Applied: ${applied.join(", ")}`);
      }
      process.exit(0);
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[migrator] FATAL: ${message}`);
      process.exit(1);
    });
}
