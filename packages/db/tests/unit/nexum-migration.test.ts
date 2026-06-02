/**
 * Unit tests for runNexumSchemaMigration and runNexumDataCutover.
 *
 * Uses fake QueryExecutor implementations — no Postgres required.
 *
 * Covers issue #368 test plan:
 *   - runNexumSchemaMigration applies pending migration files in version order
 *   - runNexumSchemaMigration is idempotent (skips already-applied versions)
 *   - runNexumDataCutover stamps every migrated row with the supplied workspaceKey
 *   - runNexumDataCutover is idempotent (uses ON CONFLICT DO NOTHING semantics)
 *   - runNexumDataCutover skips non-pending job_queue rows
 *   - runNexumDataCutover rolls back all inserts if any step fails
 *
 * @see packages/db/nexum-migration.ts
 * @see issue #368
 */

import { describe, expect, it, vi } from "vitest";
import {
  runNexumSchemaMigration,
  runNexumDataCutover,
  type QueryExecutor,
} from "../../nexum-migration.ts";

// ---------------------------------------------------------------------------
// Fake executor helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake QueryExecutor where `query` is a vi.fn() spy and
 * `transaction` runs the callback synchronously with itself as the tx.
 */
function makeFakeExecutor(
  queryImpl?: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>,
): QueryExecutor & { querySpy: ReturnType<typeof vi.fn> } {
  const querySpy = vi.fn(
    queryImpl ??
      (() => Promise.resolve({ rows: [] as Record<string, unknown>[] })),
  );

  const executor: QueryExecutor = {
    query: querySpy,
    transaction: async <T>(fn: (tx: QueryExecutor) => Promise<T>) =>
      fn(executor),
  };

  return Object.assign(executor, { querySpy });
}

/**
 * Build a fake executor that pre-loads a set of already-applied migration
 * versions. The first `SELECT version FROM nexum.schema_migrations` call
 * returns those rows; all other queries are no-ops.
 */
function makeExecutorWithApplied(
  appliedVersions: string[],
): QueryExecutor & { querySpy: ReturnType<typeof vi.fn> } {
  return makeFakeExecutor((sql: string) => {
    if (sql.includes("SELECT version FROM nexum.schema_migrations")) {
      return Promise.resolve({
        rows: appliedVersions.map((v) => ({ version: v })),
      });
    }
    return Promise.resolve({ rows: [] });
  });
}

// ---------------------------------------------------------------------------
// runNexumSchemaMigration
// ---------------------------------------------------------------------------

describe("runNexumSchemaMigration — schema migration runner (#368)", () => {
  it("applies pending migration files and records them in schema_migrations", async () => {
    const executor = makeFakeExecutor((sql: string) => {
      // schema_migrations query throws to simulate table not yet existing
      if (sql.includes("SELECT version FROM nexum.schema_migrations")) {
        return Promise.reject(new Error("relation does not exist"));
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await runNexumSchemaMigration(executor);

    // Both SQL files under migrations/nexum/ must be applied.
    expect(result.applied.length).toBeGreaterThan(0);
    expect(result.skipped).toHaveLength(0);

    // Every applied file must be recorded via INSERT INTO nexum.schema_migrations
    const insertCalls = executor.querySpy.mock.calls.filter(
      ([sql]: unknown[]) =>
        typeof sql === "string" &&
        sql.includes("INSERT INTO nexum.schema_migrations"),
    );
    expect(insertCalls.length).toBe(result.applied.length);
  });

  it("skips already-applied versions and returns them in skipped[]", async () => {
    // Pre-populate "0001" as already applied.
    const executor = makeExecutorWithApplied(["0001"]);

    const result = await runNexumSchemaMigration(executor);

    expect(result.skipped).toContain("0001__nexum_schema.sql");
    // "0002" data cutover stub is still pending.
    expect(result.applied).toContain("0002__nexum_data_cutover.sql");
  });

  it("is fully idempotent: re-running after all applied returns empty applied[]", async () => {
    // Pre-populate both known migration versions.
    const executor = makeExecutorWithApplied(["0001", "0002"]);

    const result = await runNexumSchemaMigration(executor);

    expect(result.applied).toHaveLength(0);
    expect(result.skipped.length).toBeGreaterThan(0);
  });

  it("applies migrations in lexicographic (version) order", async () => {
    const executor = makeFakeExecutor((sql: string) => {
      if (sql.includes("SELECT version FROM nexum.schema_migrations")) {
        return Promise.reject(new Error("no table"));
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await runNexumSchemaMigration(executor);

    const applied = result.applied;
    const sorted = [...applied].sort();
    expect(applied).toEqual(sorted);
  });

  it("each migration runs inside a transaction", async () => {
    const txSpy = vi.fn(
      async <T>(fn: (tx: QueryExecutor) => Promise<T>): Promise<T> => {
        const inner = makeFakeExecutor();
        return fn(inner);
      },
    );

    const executor: QueryExecutor = {
      query: vi.fn((sql: string) => {
        if (sql.includes("SELECT version FROM nexum.schema_migrations")) {
          return Promise.reject(new Error("no table"));
        }
        return Promise.resolve({ rows: [] });
      }),
      transaction: txSpy as QueryExecutor["transaction"],
    };

    const result = await runNexumSchemaMigration(executor);

    // One transaction call per applied migration.
    expect(txSpy).toHaveBeenCalledTimes(result.applied.length);
  });
});

// ---------------------------------------------------------------------------
// runNexumDataCutover
// ---------------------------------------------------------------------------

describe("runNexumDataCutover — data migration with workspace key (#368)", () => {
  it("stamps every INSERT statement with the supplied workspaceKey", async () => {
    const WORKSPACE = "ws-acme";
    const executor = makeFakeExecutor();

    await runNexumDataCutover({
      workspaceKey: WORKSPACE,
      stagingExecutor: executor,
    });

    // Every query that inserts rows must supply the workspaceKey as $1.
    const insertCalls = executor.querySpy.mock.calls.filter(
      ([sql]: unknown[]) =>
        typeof sql === "string" && sql.includes("INSERT INTO nexum."),
    );
    expect(insertCalls.length).toBeGreaterThan(0);

    for (const [, params] of insertCalls) {
      if (Array.isArray(params) && params.length > 0) {
        expect(params[0]).toBe(WORKSPACE);
      }
    }
  });

  it("all inserts use ON CONFLICT DO NOTHING (idempotent re-runs)", async () => {
    const executor = makeFakeExecutor();

    await runNexumDataCutover({
      workspaceKey: "ws-x",
      stagingExecutor: executor,
    });

    const insertCalls = executor.querySpy.mock.calls.filter(
      ([sql]: unknown[]) =>
        typeof sql === "string" && sql.includes("INSERT INTO nexum."),
    );
    for (const [sql] of insertCalls) {
      expect(sql).toContain("ON CONFLICT");
      expect(sql).toContain("DO NOTHING");
    }
  });

  it("job_queue INSERT filters to pending status only", async () => {
    const executor = makeFakeExecutor();

    await runNexumDataCutover({
      workspaceKey: "ws-x",
      stagingExecutor: executor,
    });

    const jobQueueInsert = executor.querySpy.mock.calls.find(
      ([sql]: unknown[]) =>
        typeof sql === "string" && sql.includes("nexum.job_queue"),
    );
    expect(jobQueueInsert).toBeDefined();
    expect(jobQueueInsert![0]).toContain("status = 'pending'");
  });

  it("all steps run inside a single transaction", async () => {
    let txCallCount = 0;

    const executor: QueryExecutor = {
      query: vi.fn(() => Promise.resolve({ rows: [] })),
      transaction: async <T>(
        fn: (tx: QueryExecutor) => Promise<T>,
      ): Promise<T> => {
        txCallCount++;
        const inner = makeFakeExecutor();
        return fn(inner);
      },
    };

    await runNexumDataCutover({
      workspaceKey: "ws-x",
      stagingExecutor: executor,
    });

    // The entire cutover must run inside exactly one transaction.
    expect(txCallCount).toBe(1);
  });

  it("rolls back (propagates error) when a step fails", async () => {
    let callCount = 0;

    const executor: QueryExecutor = {
      query: vi.fn(() => Promise.resolve({ rows: [] })),
      transaction: async <T>(
        fn: (tx: QueryExecutor) => Promise<T>,
      ): Promise<T> => {
        const inner: QueryExecutor = {
          query: vi.fn(() => {
            callCount++;
            if (callCount === 3) {
              // Simulate a failure on the 3rd INSERT.
              return Promise.reject(new Error("unique violation"));
            }
            return Promise.resolve({ rows: [] });
          }),
          transaction: async <U>(innerFn: (tx: QueryExecutor) => Promise<U>) =>
            innerFn(inner),
        };
        return fn(inner);
      },
    };

    await expect(
      runNexumDataCutover({ workspaceKey: "ws-x", stagingExecutor: executor }),
    ).rejects.toThrow("unique violation");
  });

  it("updates current_version_id FKs after all rows are inserted", async () => {
    const executor = makeFakeExecutor();

    await runNexumDataCutover({
      workspaceKey: "ws-x",
      stagingExecutor: executor,
    });

    // The last non-INSERT query should be the FK update.
    const updateCall = executor.querySpy.mock.calls.find(
      ([sql]: unknown[]) =>
        typeof sql === "string" && sql.includes("SET    current_version_id"),
    );
    expect(updateCall).toBeDefined();
  });
});
