/**
 * @file migrator.integration.test.ts
 *
 * Integration tests for the unified migration runner.
 *
 * These tests spin up an isolated Docker Postgres container for each suite
 * and exercise the actual SQL against a real database. They require Docker to
 * be available in the test environment.
 *
 * Test plan (issue #356):
 *   - Migrate empty DB then assert all expected tables exist.
 *   - Run migrations twice and assert idempotency (no error, no duplicate records).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgres, type PgContainer } from "../../pg-container.ts";
import { runMigrations } from "../../migrator.ts";

describe("runMigrations — integration", () => {
  let pg: PgContainer;

  beforeAll(async () => {
    pg = await startPostgres();
  }, 60_000);

  afterAll(async () => {
    await pg?.stop();
  });

  it("creates all expected tables in an empty database", async () => {
    const applied = await runMigrations({
      databaseUrl: pg.url,
      log: () => {},
    });

    // At least one migration should have been applied.
    expect(applied.length).toBeGreaterThan(0);
    expect(applied).toContain("0001_initial_graph");

    // Verify the core graph tables exist via a direct query.
    const { default: postgres } = await import("postgres");
    const sql = postgres(pg.url, { max: 1 });
    try {
      const rows = await sql<{ tablename: string }[]>`
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename IN ('entity_types', 'entities', 'relations', 'schema_migrations')
        ORDER BY tablename
      `;
      const names = rows.map((r) => r.tablename);
      expect(names).toContain("entity_types");
      expect(names).toContain("entities");
      expect(names).toContain("relations");
      expect(names).toContain("schema_migrations");
    } finally {
      await sql.end();
    }
  }, 60_000);

  it("is idempotent — running migrations twice does not error or create duplicates", async () => {
    // First run (already applied by the previous test, but this is a fresh
    // suite so we use the same container — call again).
    await runMigrations({ databaseUrl: pg.url, log: () => {} });

    // Second run — must be a no-op.
    const secondApplied = await runMigrations({
      databaseUrl: pg.url,
      log: () => {},
    });
    expect(secondApplied).toHaveLength(0);

    // Confirm no duplicate records in schema_migrations.
    const { default: postgres } = await import("postgres");
    const sql = postgres(pg.url, { max: 1 });
    try {
      const rows = await sql<{ id: string; cnt: string }[]>`
        SELECT id, COUNT(*) AS cnt
        FROM schema_migrations
        GROUP BY id
        HAVING COUNT(*) > 1
      `;
      expect(rows).toHaveLength(0);
    } finally {
      await sql.end();
    }
  }, 60_000);
});
