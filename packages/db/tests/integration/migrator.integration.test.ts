/**
 * @file migrator.integration.test.ts
 *
 * Integration tests for the unified migration runner.
 *
 * These tests spin up an isolated Docker Postgres container for each suite
 * and exercise the actual SQL against a real database. They require Docker to
 * be available in the test environment.
 *
 * When Docker is not available (e.g. in a containerised CI runner without
 * Docker-in-Docker support), the entire suite is skipped with an explicit
 * reason rather than failing.
 *
 * Issue #428 acceptance criteria tested here:
 *   - `migrate up` applies all component migrations idempotently (AC-1)
 *   - `migrate status` reports applied vs. pending (AC-4, tested via getMigrationStatus)
 *
 * Issue #428 test plan:
 *   - TP-1: fresh Postgres → migrate up → all tables present (in all schemas)
 *   - TP-2: migrate up is idempotent (runs twice, no error, no duplicates)
 */

import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgres, type PgContainer } from "../../pg-container.ts";
import {
  runMigrations,
  getMigrationStatus,
  rollbackMigrations,
} from "../../migrator.ts";

function dockerAvailable(): boolean {
  try {
    const r = spawnSync(
      "docker",
      ["version", "--format", "{{.Server.Version}}"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    return r.status === 0 && r.stdout.toString().trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Probe whether a TCP connection to host:port can be established within
 * timeoutMs. Returns true on success, false on ECONNREFUSED or timeout.
 *
 * This guards against DinD environments where Docker starts the container and
 * maps a port, but the port is only reachable on the Docker host — not from
 * within the CI container that runs the tests.
 */
function tcpReachable(
  host: string,
  port: number,
  timeoutMs = 3000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port });
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, timeoutMs);
    sock.once("connect", () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

describe("runMigrations — integration", () => {
  let pg: PgContainer | undefined;
  let skipReason: string | undefined;

  beforeAll(async () => {
    if (!dockerAvailable()) {
      skipReason = "docker not available — skipping migrator integration tests";
      return;
    }
    try {
      pg = await startPostgres();
    } catch (err) {
      skipReason = `failed to start postgres container: ${(err as Error).message}`;
      return;
    }
    // Verify the mapped port is actually reachable from this network namespace.
    // In Docker-in-Docker CI runners the container port may be reachable only
    // on the host, not from inside the job container itself.
    const urlObj = new URL(pg.url);
    const reachable = await tcpReachable(urlObj.hostname, Number(urlObj.port));
    if (!reachable) {
      await pg.stop();
      pg = undefined;
      skipReason =
        "postgres container port is not reachable from this network namespace — skipping migrator integration tests (Docker-in-Docker limitation)";
    }
  }, 60_000);

  afterAll(async () => {
    await pg?.stop();
  });

  /**
   * TP-1: fresh Postgres → migrate up → all expected tables present across all
   * component schemas (substrate, auth, nexum, sharp, public graph tables).
   */
  it("TP-1: creates all expected tables in an empty database", async () => {
    if (skipReason) {
      console.warn(skipReason);
      return;
    }
    if (!pg) throw new Error("postgres container not initialised");

    const applied = await runMigrations({
      databaseUrl: pg.url,
      log: () => {},
    });

    // At least one migration should have been applied.
    expect(applied.length).toBeGreaterThan(0);

    // The TypeScript graph migration (public schema) must be applied.
    expect(applied).toContain("0001_initial_graph");

    // Component SQL migrations must be applied.
    expect(applied.some((id) => id.startsWith("sf-db/"))).toBe(true);
    expect(applied.some((id) => id.startsWith("sf-auth/"))).toBe(true);
    expect(applied.some((id) => id.startsWith("nexum/"))).toBe(true);
    expect(applied.some((id) => id.startsWith("sharp/"))).toBe(true);

    const { default: postgres } = await import("postgres");
    const sql = postgres(pg.url, { max: 1 });
    try {
      // --- public schema: migration tracker and graph tables ---
      const publicRows = await sql<{ tablename: string }[]>`
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename IN ('entity_types', 'entities', 'relations', 'schema_migrations', 'workspaces')
        ORDER BY tablename
      `;
      const publicNames = publicRows.map((r) => r.tablename);
      expect(publicNames).toContain("schema_migrations");
      expect(publicNames).toContain("entity_types");
      expect(publicNames).toContain("entities");
      expect(publicNames).toContain("relations");
      expect(publicNames).toContain("workspaces");

      // --- auth schema: sessions, oauth_tokens, app_installations ---
      const authSchemas = await sql<{ schema_name: string }[]>`
        SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'auth'
      `;
      expect(authSchemas.length).toBe(1);

      const authRows = await sql<{ tablename: string }[]>`
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'auth'
          AND tablename IN ('sessions', 'oauth_tokens', 'app_installations')
        ORDER BY tablename
      `;
      const authNames = authRows.map((r) => r.tablename);
      expect(authNames).toContain("sessions");
      expect(authNames).toContain("oauth_tokens");
      expect(authNames).toContain("app_installations");

      // --- nexum schema: core tables ---
      const nexumSchemas = await sql<{ schema_name: string }[]>`
        SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'nexum'
      `;
      expect(nexumSchemas.length).toBe(1);

      const nexumRows = await sql<{ tablename: string }[]>`
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'nexum'
        ORDER BY tablename
      `;
      const nexumNames = nexumRows.map((r) => r.tablename);
      // nexum schema must have at least its core tables
      expect(nexumNames.length).toBeGreaterThan(0);

      // --- sharp schema: VCS core tables ---
      const sharpSchemas = await sql<{ schema_name: string }[]>`
        SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'sharp'
      `;
      expect(sharpSchemas.length).toBe(1);

      const sharpRows = await sql<{ tablename: string }[]>`
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'sharp'
          AND tablename IN ('repos', 'objects', 'refs', 'commit_metadata', 'commit_paths')
        ORDER BY tablename
      `;
      const sharpNames = sharpRows.map((r) => r.tablename);
      expect(sharpNames).toContain("repos");
      expect(sharpNames).toContain("objects");
      expect(sharpNames).toContain("refs");
      expect(sharpNames).toContain("commit_metadata");
      expect(sharpNames).toContain("commit_paths");
    } finally {
      await sql.end();
    }
  }, 90_000);

  /**
   * TP-2: migrate up is idempotent — running twice does not error or duplicate records.
   */
  it("TP-2: is idempotent — running migrations twice does not error or create duplicates", async () => {
    if (skipReason) {
      console.warn(skipReason);
      return;
    }
    if (!pg) throw new Error("postgres container not initialised");

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

  /**
   * getMigrationStatus — reports applied vs. pending correctly.
   */
  it("getMigrationStatus — reports all as applied after migrate up", async () => {
    if (skipReason) {
      console.warn(skipReason);
      return;
    }
    if (!pg) throw new Error("postgres container not initialised");

    const statuses = await getMigrationStatus({ databaseUrl: pg.url });

    // All migrations should be applied after the previous tests ran migrate up.
    const pending = statuses.filter((s) => !s.applied);
    expect(pending).toHaveLength(0);

    // Statuses should include all component namespaces.
    const ids = statuses.map((s) => s.id);
    expect(ids.some((id) => id.startsWith("sf-db/"))).toBe(true);
    expect(ids.some((id) => id.startsWith("sf-auth/"))).toBe(true);
    expect(ids.some((id) => id.startsWith("nexum/"))).toBe(true);
    expect(ids.some((id) => id.startsWith("sharp/"))).toBe(true);
    expect(ids).toContain("0001_initial_graph");
  }, 60_000);

  /**
   * rollbackMigrations — removes tracking records so the migration can be re-applied.
   */
  it("rollbackMigrations — removes the last applied tracking record", async () => {
    if (skipReason) {
      console.warn(skipReason);
      return;
    }
    if (!pg) throw new Error("postgres container not initialised");

    // Roll back 1 step.
    const rolledBack = await rollbackMigrations({
      databaseUrl: pg.url,
      steps: 1,
      log: () => {},
    });
    expect(rolledBack).toHaveLength(1);

    // After rollback, that migration should appear as pending.
    const statuses = await getMigrationStatus({ databaseUrl: pg.url });
    const pending = statuses.filter((s) => !s.applied);
    expect(pending.map((s) => s.id)).toContain(rolledBack[0]);

    // Re-apply to restore state.
    await runMigrations({ databaseUrl: pg.url, log: () => {} });
  }, 60_000);
});
