/**
 * Integration tests: PostgreSQL Row-Level Security — workspace isolation.
 *
 * Spins up a real PostgreSQL 16 container, applies the RLS migration stub,
 * and proves the acceptance criteria from issue #358:
 *
 *  AC-1: A connection in workspace A cannot SELECT workspace B rows.
 *  AC-2: A connection in workspace A cannot UPDATE or DELETE workspace B rows.
 *  TP-1: Cross-workspace SELECT returns zero rows under RLS.
 *  TP-2: Cross-workspace UPDATE affects zero rows.
 *  BYPASS: An explicit privileged role (superfield_admin with BYPASSRLS)
 *          bypasses RLS and can read all rows — the default app role cannot.
 *
 * The tests use a lightweight in-test table (`rls_items`) created in the
 * `public` schema so there is no dependency on the Sharp/Nexum/Episodes
 * schemas that live in separate repositories.
 *
 * Requires Docker to be running. Tests are skipped gracefully when Docker
 * is unavailable.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { startPostgres, type PgContainer } from "../../pg-container.ts";
import {
  clearWorkspaceContext,
  getWorkspaceContext,
  RlsContextError,
  setWorkspaceContext,
  withWorkspaceTransaction,
} from "../../rls.ts";

function dockerAvailable(): boolean {
  try {
    const r = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    return r.status === 0 && r.stdout.toString().trim().length > 0;
  } catch {
    return false;
  }
}

function tcpReachable(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port });
    const timer = setTimeout(() => { sock.destroy(); resolve(false); }, timeoutMs);
    sock.once("connect", () => { clearTimeout(timer); sock.destroy(); resolve(true); });
    sock.once("error", () => { clearTimeout(timer); resolve(false); });
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MIGRATION_PATH = join(
  new URL("../../migrations/0001_rls_workspace_isolation.sql", import.meta.url)
    .pathname,
);

/** Create a connected pg.Client for the given container URL. */
async function connect(url: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

/** Execute the raw SQL migration file. */
async function applyMigration(client: Client, sql: string): Promise<void> {
  await client.query(sql);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("RLS workspace isolation", { timeout: 90_000 }, () => {
  let pg: PgContainer | undefined;
  let adminClient: Client; // connects as the superuser (bypasses RLS via BYPASSRLS role)
  let appClient: Client; // connects as the restricted app role
  let skipReason: string | undefined;

  const APP_ROLE = "app_role";
  const WORKSPACE_A = "ws-alpha";
  const WORKSPACE_B = "ws-beta";

  // -----------------------------------------------------------------------
  // Setup: start postgres, create roles, create test table, enable RLS.
  // -----------------------------------------------------------------------

  beforeAll(async () => {
    if (!dockerAvailable()) {
      skipReason = "docker not available — skipping RLS integration tests";
      return;
    }
    try {
      pg = await startPostgres();
    } catch (err) {
      skipReason = `failed to start postgres container: ${(err as Error).message}`;
      return;
    }
    const urlObj = new URL(pg.url);
    if (!(await tcpReachable(urlObj.hostname, Number(urlObj.port)))) {
      await pg.stop();
      pg = undefined;
      skipReason = "postgres container port not reachable (Docker-in-Docker) — skipping";
      return;
    }
    // Admin connection (superuser — bypasses RLS by default as owner).
    adminClient = await connect(pg.url);

    // Create the privileged superfield_admin role with BYPASSRLS.
    // This is the correct mechanism for admin bypass — a PERMISSIVE policy
    // cannot override RESTRICTIVE policies, but BYPASSRLS does.
    await adminClient.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'superfield_admin') THEN
            CREATE ROLE superfield_admin BYPASSRLS NOLOGIN;
          ELSE
            ALTER ROLE superfield_admin BYPASSRLS;
          END IF;
        END $$
      `);

    // Grant superfield_admin to the superuser so we can SET ROLE to it in tests.
    await adminClient.query(`GRANT superfield_admin TO superfield`);

    // Create a restricted application role that is NOT a superuser and does
    // NOT have BYPASSRLS.
    await adminClient.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
            CREATE ROLE ${APP_ROLE} LOGIN PASSWORD 'app_pass';
          END IF;
        END $$
      `);

    // Grant database access.
    await adminClient.query(
      `GRANT CONNECT ON DATABASE superfield TO ${APP_ROLE}`,
    );

    // Create a minimal workspace-keyed table in the public schema.
    await adminClient.query(`
        CREATE TABLE IF NOT EXISTS public.rls_items (
          id            SERIAL PRIMARY KEY,
          workspace_id  TEXT   NOT NULL,
          payload       TEXT   NOT NULL
        )
      `);

    // Grant table access to both roles.
    await adminClient.query(
      `GRANT USAGE ON SCHEMA public TO superfield_admin, ${APP_ROLE}`,
    );
    await adminClient.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON public.rls_items TO superfield_admin, ${APP_ROLE}`,
    );

    // Seed rows BEFORE enabling RLS so the superuser can write freely.
    await adminClient.query(
      `
        INSERT INTO public.rls_items (workspace_id, payload) VALUES
          ($1, 'alpha-row-1'),
          ($1, 'alpha-row-2'),
          ($2, 'beta-row-1')
      `,
      [WORKSPACE_A, WORKSPACE_B],
    );

    // Enable RLS on the test table (mirrors what the migration does on real
    // component tables).
    await adminClient.query(
      `ALTER TABLE public.rls_items ENABLE ROW LEVEL SECURITY`,
    );
    // FORCE applies RLS even to the table owner (but not to superusers).
    await adminClient.query(
      `ALTER TABLE public.rls_items FORCE ROW LEVEL SECURITY`,
    );

    // App-role policies — PERMISSIVE, keyed on app.workspace_id.
    // BYPASSRLS on superfield_admin makes a separate bypass policy unnecessary.
    await adminClient.query(`
        CREATE POLICY rls_workspace_select ON public.rls_items
          AS PERMISSIVE
          FOR SELECT
          USING (workspace_id = current_setting('app.workspace_id', true))
      `);
    await adminClient.query(`
        CREATE POLICY rls_workspace_insert ON public.rls_items
          AS PERMISSIVE
          FOR INSERT
          WITH CHECK (workspace_id = current_setting('app.workspace_id', true))
      `);
    await adminClient.query(`
        CREATE POLICY rls_workspace_update ON public.rls_items
          AS PERMISSIVE
          FOR UPDATE
          USING (workspace_id = current_setting('app.workspace_id', true))
          WITH CHECK (workspace_id = current_setting('app.workspace_id', true))
      `);
    await adminClient.query(`
        CREATE POLICY rls_workspace_delete ON public.rls_items
          AS PERMISSIVE
          FOR DELETE
          USING (workspace_id = current_setting('app.workspace_id', true))
      `);

    // App-role connection (restricted, no BYPASSRLS).
    const appUrl = pg.url.replace(
      /postgres:\/\/[^:]+:[^@]+@/,
      `postgres://${APP_ROLE}:app_pass@`,
    );
    appClient = await connect(appUrl);
  }, 60_000);

  afterAll(async () => {
    await appClient?.end();
    await adminClient?.end();
    await pg?.stop();
  });

  // Skip all tests when Docker is unavailable or container port is unreachable.
  beforeEach((ctx) => {
    if (skipReason) {
      console.warn(skipReason);
      ctx.skip();
    }
  });

  // -----------------------------------------------------------------------
  // setWorkspaceContext / clearWorkspaceContext / getWorkspaceContext
  // -----------------------------------------------------------------------

  describe("setWorkspaceContext", () => {
    it("throws RlsContextError for an empty workspaceId", async () => {
      await expect(setWorkspaceContext(adminClient, "")).rejects.toThrow(
        RlsContextError,
      );
    });

    it("throws RlsContextError for a whitespace-only workspaceId", async () => {
      await expect(setWorkspaceContext(adminClient, "   ")).rejects.toThrow(
        RlsContextError,
      );
    });

    it("sets app.workspace_id on the session", async () => {
      const client = await connect(pg.url);
      try {
        await client.query("BEGIN");
        await setWorkspaceContext(client, WORKSPACE_A, { transaction: true });
        const ctx = await getWorkspaceContext(client);
        expect(ctx).toBe(WORKSPACE_A);
        await client.query("ROLLBACK");
      } finally {
        await client.end();
      }
    });

    it("SET LOCAL is cleared after transaction ROLLBACK", async () => {
      const client = await connect(pg.url);
      try {
        await client.query("BEGIN");
        await setWorkspaceContext(client, WORKSPACE_A, { transaction: true });
        await client.query("ROLLBACK");
        // After rollback the SET LOCAL is undone.
        const ctx = await getWorkspaceContext(client);
        expect(ctx).toBeNull();
      } finally {
        await client.end();
      }
    });

    it("clearWorkspaceContext resets the session variable", async () => {
      const client = await connect(pg.url);
      try {
        await setWorkspaceContext(client, WORKSPACE_A, {
          transaction: false,
        });
        let ctx = await getWorkspaceContext(client);
        expect(ctx).toBe(WORKSPACE_A);

        await clearWorkspaceContext(client);
        ctx = await getWorkspaceContext(client);
        expect(ctx).toBeNull();
      } finally {
        await client.end();
      }
    });
  });

  // -----------------------------------------------------------------------
  // AC-1 / TP-1: Cross-workspace SELECT returns zero rows under RLS
  // -----------------------------------------------------------------------

  describe("AC-1 / TP-1: cross-workspace SELECT returns zero rows", () => {
    it("app role scoped to workspace A cannot see workspace B rows", async () => {
      await withWorkspaceTransaction(appClient, WORKSPACE_A, async (c) => {
        const result = await (c as Client).query<{ payload: string }>(
          `SELECT payload FROM public.rls_items WHERE workspace_id = $1`,
          [WORKSPACE_B],
        );
        // RLS policy filters these rows out — zero rows returned.
        expect(result.rows).toHaveLength(0);
      });
    });

    it("app role scoped to workspace A sees only its own rows", async () => {
      await withWorkspaceTransaction(appClient, WORKSPACE_A, async (c) => {
        const result = await (c as Client).query<{ payload: string }>(
          `SELECT payload FROM public.rls_items ORDER BY payload`,
        );
        expect(result.rows.map((r) => r.payload)).toEqual([
          "alpha-row-1",
          "alpha-row-2",
        ]);
      });
    });

    it("app role scoped to workspace B sees only its own rows", async () => {
      await withWorkspaceTransaction(appClient, WORKSPACE_B, async (c) => {
        const result = await (c as Client).query<{ payload: string }>(
          `SELECT payload FROM public.rls_items ORDER BY payload`,
        );
        expect(result.rows.map((r) => r.payload)).toEqual(["beta-row-1"]);
      });
    });
  });

  // -----------------------------------------------------------------------
  // AC-2 / TP-2: Cross-workspace UPDATE affects zero rows
  // -----------------------------------------------------------------------

  describe("AC-2 / TP-2: cross-workspace UPDATE affects zero rows", () => {
    it("app role scoped to workspace A cannot update workspace B rows", async () => {
      await withWorkspaceTransaction(appClient, WORKSPACE_A, async (c) => {
        const result = await (c as Client).query(
          `UPDATE public.rls_items SET payload = 'hacked' WHERE workspace_id = $1`,
          [WORKSPACE_B],
        );
        // rowCount is 0 because RLS filters out workspace B rows.
        expect(result.rowCount).toBe(0);
      });

      // Verify the beta row was not touched — use admin (superuser) to bypass RLS.
      const check = await adminClient.query<{ payload: string }>(
        `SELECT payload FROM public.rls_items WHERE workspace_id = $1`,
        [WORKSPACE_B],
      );
      expect(check.rows[0]?.payload).toBe("beta-row-1");
    });

    it("app role scoped to workspace A cannot delete workspace B rows", async () => {
      await withWorkspaceTransaction(appClient, WORKSPACE_A, async (c) => {
        const result = await (c as Client).query(
          `DELETE FROM public.rls_items WHERE workspace_id = $1`,
          [WORKSPACE_B],
        );
        expect(result.rowCount).toBe(0);
      });

      // Beta row still exists.
      const check = await adminClient.query<{ cnt: string }>(
        `SELECT count(*) AS cnt FROM public.rls_items WHERE workspace_id = $1`,
        [WORKSPACE_B],
      );
      expect(Number(check.rows[0]?.cnt)).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // BYPASS: superfield_admin (BYPASSRLS) sees all rows;
  //         default app role without workspace context sees zero rows (safe).
  // -----------------------------------------------------------------------

  describe("BYPASS: privileged role bypasses RLS", () => {
    it("superfield_admin (BYPASSRLS, via SET ROLE) can see all rows without workspace context", async () => {
      const adminConn = await connect(pg.url);
      try {
        // Elevate to superfield_admin — BYPASSRLS skips all RLS checks.
        await adminConn.query("SET ROLE superfield_admin");
        const result = await adminConn.query<{ cnt: string }>(
          `SELECT count(*) AS cnt FROM public.rls_items`,
        );
        // All 3 seed rows are visible to the BYPASSRLS role.
        expect(Number(result.rows[0]?.cnt)).toBe(3);
      } finally {
        await adminConn.query("RESET ROLE");
        await adminConn.end();
      }
    });

    it("default app role without workspace context sees zero rows (safe default)", async () => {
      const freshAppUrl = pg.url.replace(
        /postgres:\/\/[^:]+:[^@]+@/,
        `postgres://${APP_ROLE}:app_pass@`,
      );
      const freshClient = await connect(freshAppUrl);
      try {
        // No workspace context set — app.workspace_id is absent.
        const result = await freshClient.query<{ cnt: string }>(
          `SELECT count(*) AS cnt FROM public.rls_items`,
        );
        // Safe default: no workspace set → no rows visible.
        expect(Number(result.rows[0]?.cnt)).toBe(0);
      } finally {
        await freshClient.end();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Migration stub: the SQL file is valid and executes without error
  // -----------------------------------------------------------------------

  describe("migration stub 0001_rls_workspace_isolation.sql", () => {
    it("executes without error against a real Postgres instance", async () => {
      const sql = readFileSync(MIGRATION_PATH, "utf-8");
      // The migration uses IF NOT EXISTS guards and NOTICE for absent tables —
      // it must not throw even when sharp/nexum/episodes/auth schemas are absent.
      await expect(applyMigration(adminClient, sql)).resolves.not.toThrow();
    });
  });
});
