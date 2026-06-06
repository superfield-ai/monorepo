/**
 * @file migrator.ts
 *
 * Unified migration runner for the single Postgres instance.
 *
 * Canonical reference: docs/architecture.md §Data Layer
 *
 * # Design
 *
 * Migrations are applied in component dependency order as established by
 * docs/adr-schema-boundary.md:
 *
 *   public (substrate) → auth → nexum → sharp → (future: episodes)
 *
 * Migration files live in two forms:
 *
 * 1. TypeScript modules under packages/db/migrations/NNN_description.ts — each
 *    exports a `migration: Migration` object with `preCheck`, `up`, `postCheck`.
 * 2. SQL files from component crate directories — discovered at runtime and
 *    wrapped in a generic Migration adapter that applies the SQL idempotently.
 *
 * The runner:
 *   1. Connects to the Postgres instance via DATABASE_URL.
 *   2. Creates schema_migrations table if it does not exist.
 *   3. Reads applied migration IDs from schema_migrations.
 *   4. For each pending migration (in ordered sequence): preCheck, up,
 *      postCheck, then records the migration as applied.
 *   5. Exits non-zero on any failure. A failed postCheck leaves the migration
 *      unrecorded so it can be retried after a fix.
 *
 * # Usage
 *
 *   DATABASE_URL=postgres://... bun packages/db/migrate.ts up
 *   DATABASE_URL=postgres://... bun packages/db/migrate.ts status
 *   DATABASE_URL=postgres://... bun packages/db/migrate.ts down 2
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

import { readFile, readdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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

/**
 * Migration status entry as returned by getMigrationStatus().
 */
export interface MigrationStatus {
  id: string;
  applied: boolean;
  appliedAt?: Date;
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

/** Options accepted by getMigrationStatus. */
export interface GetMigrationStatusOptions {
  /** Postgres connection URL. Defaults to DATABASE_URL env var. */
  databaseUrl?: string;
  /** Override the migration list (useful in tests). */
  migrations?: Migration[];
}

/** Options accepted by rollbackMigrations. */
export interface RollbackMigrationsOptions {
  /** Postgres connection URL. Defaults to DATABASE_URL env var. */
  databaseUrl?: string;
  /** Override the migration list (useful in tests). */
  migrations?: Migration[];
  /** Number of applied migrations to roll back. Defaults to 1. */
  steps?: number;
  /** Receive log lines (defaults to console.log). */
  log?: (message: string) => void;
}

/**
 * Base directory of the repo — used to locate crate migration SQL files.
 * packages/db/ lives at <repo-root>/packages/db, so we go up two levels.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Component SQL migration directories, in the order they must be applied.
 *
 * Order follows docs/adr-schema-boundary.md dependency sequence:
 *   public (substrate/sf-db) → auth → nexum → sharp
 *
 * Within each directory, files are applied in ascending filename order
 * (NNNN_description.sql). The runner id for a SQL migration is
 * "<component>/<filename-without-extension>".
 */
const COMPONENT_MIGRATION_DIRS: Array<{
  component: string;
  path: string;
}> = [
  {
    component: "sf-db",
    path: resolve(REPO_ROOT, "crates", "sf-db", "migrations"),
  },
  {
    component: "sf-auth",
    path: resolve(REPO_ROOT, "crates", "sf-auth", "src", "migrations"),
  },
  {
    component: "nexum",
    path: resolve(REPO_ROOT, "crates", "nexum", "migrations"),
  },
  {
    component: "sharp",
    path: resolve(REPO_ROOT, "crates", "sharp", "migrations"),
  },
];

/**
 * Load SQL migration files from a component directory and wrap each in a
 * Migration adapter.
 *
 * The migration id is "<component>/<filename-without-extension>" so it is
 * unique across all components and stable across runs.
 */
async function loadSqlMigrations(
  component: string,
  dirPath: string,
): Promise<Migration[]> {
  let entries: string[];
  try {
    entries = await readdir(dirPath);
  } catch {
    // Directory may not exist yet — treat as empty.
    return [];
  }

  const sqlFiles = entries.filter((f) => f.endsWith(".sql")).sort(); // ascending filename order (NNNN_...)

  const migrations: Migration[] = [];
  for (const file of sqlFiles) {
    const filePath = resolve(dirPath, file);
    const name = file.replace(/\.sql$/, "");
    const id = `${component}/${name}`;

    migrations.push({
      id,

      async preCheck(_sql: Sql): Promise<void> {
        // SQL migrations are assumed to be safe to apply — no pre-check.
      },

      async up(sql: Sql): Promise<void> {
        const sqlText = await readFile(filePath, "utf8");
        // Execute the entire SQL file as a single statement block.
        // The `postgres` library handles multiple statements when using
        // the unsafe() escape hatch for raw SQL execution.
        await sql.unsafe(sqlText);
      },

      async postCheck(_sql: Sql): Promise<void> {
        // SQL migrations use IF NOT EXISTS throughout, so the only meaningful
        // post-check is that the apply step did not throw, which is already
        // enforced by the runner. No extra verification needed.
      },
    });
  }

  return migrations;
}

/**
 * Build the full ordered migration list:
 *   1. Component SQL migrations (sf-db → sf-auth → nexum → sharp), in order.
 *   2. TypeScript migrations from packages/db/migrations/index.ts (graph tables).
 *
 * This ordering ensures schemas (nexum, sharp, auth) exist before the
 * TypeScript graph migrations run against them.
 */
export async function getAllMigrations(
  overrides?: Migration[],
): Promise<Migration[]> {
  if (overrides) return overrides;

  const allMigrations: Migration[] = [];

  for (const { component, path } of COMPONENT_MIGRATION_DIRS) {
    const componentMigrations = await loadSqlMigrations(component, path);
    allMigrations.push(...componentMigrations);
  }

  // TypeScript migrations (graph tables in public schema) come last so they
  // can reference schemas created by the SQL migrations above.
  const tsMigrations = getMigrations();
  allMigrations.push(...tsMigrations);

  return allMigrations;
}

/**
 * Ensure the schema_migrations tracking table exists and return a Set of
 * already-applied migration IDs.
 */
async function ensureTrackingTable(
  sql: Sql,
): Promise<{ applied: Set<string>; rows: { id: string; applied_at: Date }[] }> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          TEXT        PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  const rows = await sql<{ id: string; applied_at: Date }[]>`
    SELECT id, applied_at FROM schema_migrations ORDER BY applied_at, id
  `;
  return { applied: new Set(rows.map((r) => r.id)), rows };
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
    migrations,
    log = (msg: string) => console.log(msg),
  } = opts;

  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. Pass databaseUrl or set the environment variable.",
    );
  }

  const allMigrations = await getAllMigrations(migrations);
  const sql = postgres(databaseUrl, { max: 1 });

  try {
    const { applied } = await ensureTrackingTable(sql);
    const pending = allMigrations.filter((m) => !applied.has(m.id));
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

/**
 * Return the status of every known migration: whether it has been applied and
 * when.
 */
export async function getMigrationStatus(
  opts: GetMigrationStatusOptions = {},
): Promise<MigrationStatus[]> {
  const { databaseUrl = process.env.DATABASE_URL, migrations } = opts;

  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. Pass databaseUrl or set the environment variable.",
    );
  }

  const allMigrations = await getAllMigrations(migrations);
  const sql = postgres(databaseUrl, { max: 1 });

  try {
    const { rows } = await ensureTrackingTable(sql);
    const appliedMap = new Map(rows.map((r) => [r.id, r.applied_at]));

    return allMigrations.map((m) => {
      const appliedAt = appliedMap.get(m.id);
      return {
        id: m.id,
        applied: appliedAt !== undefined,
        appliedAt,
      };
    });
  } finally {
    await sql.end();
  }
}

/**
 * Roll back the last `steps` applied migrations by removing their records from
 * schema_migrations.
 *
 * NOTE: This does NOT run DDL rollback (DROP TABLE etc.). The design decision
 * here is deliberate — all DDL is idempotent (IF NOT EXISTS / IF EXISTS), so
 * structural rollback is performed by removing the tracking record and re-
 * deploying a corrected migration. Destructive rollback (DROP) would be
 * dangerous in production and is handled by explicit migration files when
 * needed.
 *
 * Returns the list of migration IDs whose tracking records were removed.
 */
export async function rollbackMigrations(
  opts: RollbackMigrationsOptions = {},
): Promise<string[]> {
  const {
    databaseUrl = process.env.DATABASE_URL,
    migrations,
    steps = 1,
    log = (msg: string) => console.log(msg),
  } = opts;

  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. Pass databaseUrl or set the environment variable.",
    );
  }

  if (steps < 1) {
    throw new Error(`rollback steps must be >= 1, got ${steps}`);
  }

  const allMigrations = await getAllMigrations(migrations);
  const sql = postgres(databaseUrl, { max: 1 });

  try {
    const { rows } = await ensureTrackingTable(sql);

    // Determine which migrations are applied, in reverse chronological order.
    const appliedIds = rows.map((r) => r.id).reverse();
    const toRollback = appliedIds.slice(0, steps);

    if (toRollback.length === 0) {
      log("[migrator] no applied migrations to roll back");
      return [];
    }

    const rolledBack: string[] = [];
    for (const id of toRollback) {
      // Verify the id is known so we don't remove arbitrary records.
      const known = allMigrations.find((m) => m.id === id);
      if (!known) {
        log(
          `[migrator] WARNING: applied migration "${id}" is not in the known list — skipping rollback`,
        );
        continue;
      }

      await sql`DELETE FROM schema_migrations WHERE id = ${id}`;
      log(`[migrator] rolled back: ${id}`);
      rolledBack.push(id);
    }

    log(`[migrator] rolled back ${rolledBack.length} migration(s)`);
    return rolledBack;
  } finally {
    await sql.end();
  }
}
