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
 * Test plan (issue #356):
 *   - Migrate empty DB then assert all expected tables exist.
 *   - Run migrations twice and assert idempotency (no error, no duplicate records).
 */

import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgres, type PgContainer } from "../../pg-container.ts";
import { runMigrations } from "../../migrator.ts";

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

  it("creates all expected tables in an empty database", async () => {
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
});
