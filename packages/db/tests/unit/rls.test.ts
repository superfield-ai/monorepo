/**
 * @file rls.test.ts
 *
 * Unit tests for the RLS workspace context helpers in packages/db/rls.ts.
 *
 * These tests cover the input validation and SQL command generation logic
 * without a live Postgres connection — a minimal mock client captures the
 * SQL strings that would be sent.
 *
 * Integration tests (with a real Postgres container) live in
 * packages/db/tests/integration/rls-workspace-isolation.test.ts.
 *
 * @see packages/db/rls.ts
 * @see issue #430
 */

import { describe, expect, it } from "vitest";
import {
  clearWorkspaceContext,
  getWorkspaceContext,
  RlsContextError,
  setWorkspaceContext,
  withWorkspaceTransaction,
  type PgQueryable,
} from "../../rls.ts";

// ---------------------------------------------------------------------------
// Minimal mock client
// ---------------------------------------------------------------------------

/** Capture every SQL statement sent to the mock client. */
function makeClient(overrides: Partial<{ rows: unknown[] }> = {}): {
  client: PgQueryable;
  queries: string[];
} {
  const queries: string[] = [];
  const client: PgQueryable = {
    async query(sql: string) {
      queries.push(sql.trim());
      // Return a result shaped like pg.QueryResult for getWorkspaceContext.
      return {
        rows: overrides.rows ?? [],
        rowCount: 0,
      };
    },
  };
  return { client, queries };
}

// ---------------------------------------------------------------------------
// setWorkspaceContext — input validation
// ---------------------------------------------------------------------------

describe("setWorkspaceContext — input validation", () => {
  it("throws RlsContextError for an empty string", async () => {
    const { client } = makeClient();
    await expect(setWorkspaceContext(client, "")).rejects.toThrow(
      RlsContextError,
    );
  });

  it("throws RlsContextError for a whitespace-only string", async () => {
    const { client } = makeClient();
    await expect(setWorkspaceContext(client, "   ")).rejects.toThrow(
      RlsContextError,
    );
  });

  it("throws RlsContextError for a workspaceId with special characters", async () => {
    const { client } = makeClient();
    // Single quotes and semicolons are not in the safe charset.
    await expect(
      setWorkspaceContext(client, "ws'; DROP TABLE users; --"),
    ).rejects.toThrow(RlsContextError);
  });

  it("throws RlsContextError for a workspaceId with spaces", async () => {
    const { client } = makeClient();
    await expect(setWorkspaceContext(client, "ws alpha")).rejects.toThrow(
      RlsContextError,
    );
  });
});

// ---------------------------------------------------------------------------
// setWorkspaceContext — SQL command generation
// ---------------------------------------------------------------------------

describe("setWorkspaceContext — SQL generation", () => {
  it("uses SET LOCAL by default (transaction: true)", async () => {
    const { client, queries } = makeClient();
    await setWorkspaceContext(client, "ws-alpha");
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/^SET LOCAL app\.workspace_id TO 'ws-alpha'$/i);
  });

  it("uses SET LOCAL when transaction option is true", async () => {
    const { client, queries } = makeClient();
    await setWorkspaceContext(client, "ws-alpha", { transaction: true });
    expect(queries[0]).toMatch(/^SET LOCAL/i);
  });

  it("uses SET (session-scoped) when transaction option is false", async () => {
    const { client, queries } = makeClient();
    await setWorkspaceContext(client, "ws-alpha", { transaction: false });
    expect(queries[0]).toMatch(/^SET app\.workspace_id TO 'ws-alpha'$/i);
    expect(queries[0]).not.toMatch(/LOCAL/i);
  });

  it("accepts UUID-shaped workspaceId", async () => {
    const { client, queries } = makeClient();
    const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    await setWorkspaceContext(client, uuid);
    expect(queries[0]).toContain(uuid);
  });

  it("accepts slug-shaped workspaceId with hyphens and underscores", async () => {
    const { client, queries } = makeClient();
    await setWorkspaceContext(client, "my_workspace-01");
    expect(queries[0]).toContain("my_workspace-01");
  });
});

// ---------------------------------------------------------------------------
// clearWorkspaceContext
// ---------------------------------------------------------------------------

describe("clearWorkspaceContext", () => {
  it("sends RESET app.workspace_id", async () => {
    const { client, queries } = makeClient();
    await clearWorkspaceContext(client);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/^RESET app\.workspace_id$/i);
  });
});

// ---------------------------------------------------------------------------
// getWorkspaceContext
// ---------------------------------------------------------------------------

describe("getWorkspaceContext", () => {
  it("returns the workspace_id value from the query result", async () => {
    const { client } = makeClient({ rows: [{ workspace_id: "ws-alpha" }] });
    const ctx = await getWorkspaceContext(client);
    expect(ctx).toBe("ws-alpha");
  });

  it("returns null when the result row has an empty string", async () => {
    const { client } = makeClient({ rows: [{ workspace_id: "" }] });
    const ctx = await getWorkspaceContext(client);
    expect(ctx).toBeNull();
  });

  it("returns null when the result row has a null value", async () => {
    const { client } = makeClient({ rows: [{ workspace_id: null }] });
    const ctx = await getWorkspaceContext(client);
    expect(ctx).toBeNull();
  });

  it("returns null when the result has no rows", async () => {
    const { client } = makeClient({ rows: [] });
    const ctx = await getWorkspaceContext(client);
    expect(ctx).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// withWorkspaceTransaction
// ---------------------------------------------------------------------------

describe("withWorkspaceTransaction", () => {
  it("wraps the callback in BEGIN / COMMIT", async () => {
    const { client, queries } = makeClient();
    await withWorkspaceTransaction(client, "ws-alpha", async () => {});
    expect(queries[0]).toMatch(/^BEGIN$/i);
    expect(queries[queries.length - 1]).toMatch(/^COMMIT$/i);
  });

  it("sets SET LOCAL before calling the callback", async () => {
    const { client, queries } = makeClient();
    await withWorkspaceTransaction(client, "ws-alpha", async () => {});
    // ORDER: BEGIN → SET LOCAL → callback → COMMIT
    expect(queries[1]).toMatch(/^SET LOCAL app\.workspace_id TO 'ws-alpha'$/i);
  });

  it("returns the callback return value", async () => {
    const { client } = makeClient();
    const result = await withWorkspaceTransaction(
      client,
      "ws-alpha",
      async () => 42,
    );
    expect(result).toBe(42);
  });

  it("rolls back and re-throws when the callback throws", async () => {
    const { client, queries } = makeClient();
    const err = new Error("boom");
    await expect(
      withWorkspaceTransaction(client, "ws-alpha", async () => {
        throw err;
      }),
    ).rejects.toThrow("boom");
    expect(queries[queries.length - 1]).toMatch(/^ROLLBACK$/i);
  });

  it("throws RlsContextError for an empty workspaceId", async () => {
    const { client } = makeClient();
    await expect(
      withWorkspaceTransaction(client, "", async () => {}),
    ).rejects.toThrow(RlsContextError);
  });
});
