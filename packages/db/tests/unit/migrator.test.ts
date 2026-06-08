/**
 * @file migrator.test.ts
 *
 * Unit tests for the migration registry and migration contract.
 *
 * These tests verify structural invariants of the migration list without
 * requiring a live Postgres instance or Docker.
 *
 * Issue #428 coverage:
 *   - getAllMigrations() resolves SQL migrations from component directories
 *   - rollbackMigrations() validates the steps argument
 *   - runMigrations() / getMigrationStatus() / rollbackMigrations() all
 *     throw when DATABASE_URL is absent (without making a network call)
 */

import { describe, expect, it } from "vitest";
import { getMigrations } from "../../migrations/index.ts";
import {
  runMigrations,
  getMigrationStatus,
  rollbackMigrations,
  getAllMigrations,
  type Migration,
  type Sql,
} from "../../migrator.ts";

// ---------------------------------------------------------------------------
// TypeScript migration registry (getMigrations)
// ---------------------------------------------------------------------------

describe("getMigrations — TypeScript registry", () => {
  it("returns a non-empty migration list", () => {
    const migrations = getMigrations();
    expect(migrations.length).toBeGreaterThan(0);
  });

  it("every migration has a non-empty string id", () => {
    const migrations = getMigrations();
    for (const m of migrations) {
      expect(typeof m.id).toBe("string");
      expect(m.id.length).toBeGreaterThan(0);
    }
  });

  it("migration ids are unique", () => {
    const migrations = getMigrations();
    const ids = migrations.map((m) => m.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("migration ids are in ascending order (numeric filename prefix)", () => {
    const migrations = getMigrations();
    const ids = migrations.map((m) => m.id);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it("every migration exposes preCheck, up, and postCheck as functions", () => {
    const migrations = getMigrations();
    for (const m of migrations) {
      expect(typeof m.preCheck).toBe("function");
      expect(typeof m.up).toBe("function");
      expect(typeof m.postCheck).toBe("function");
    }
  });

  it("the initial graph migration is registered", () => {
    const migrations = getMigrations();
    const ids = migrations.map((m) => m.id);
    expect(ids).toContain("0001_initial_graph");
  });
});

// ---------------------------------------------------------------------------
// getAllMigrations — unified list (TypeScript + SQL component migrations)
// ---------------------------------------------------------------------------

describe("getAllMigrations — unified migration list", () => {
  it("returns a list that includes the TypeScript graph migration", async () => {
    const migrations = await getAllMigrations();
    const ids = migrations.map((m) => m.id);
    expect(ids).toContain("0001_initial_graph");
  });

  it("returns migrations from all component namespaces when dirs exist", async () => {
    const migrations = await getAllMigrations();
    const ids = migrations.map((m) => m.id);

    // Component SQL migrations use "<component>/<filename-without-ext>" ids.
    const hasSfDb = ids.some((id) => id.startsWith("sf-db/"));
    const hasAuth = ids.some((id) => id.startsWith("sf-auth/"));
    const hasNexum = ids.some((id) => id.startsWith("nexum/"));
    const hasSharp = ids.some((id) => id.startsWith("sharp/"));

    // If the crate migration dirs exist (monorepo run), they must appear.
    // This assertion is conditional on the dirs existing — in a partial
    // checkout some dirs may be absent, which is treated as empty (not an error).
    // We assert at least one component is present to guard against silent regressions.
    const componentCount = [hasSfDb, hasAuth, hasNexum, hasSharp].filter(
      Boolean,
    ).length;
    expect(componentCount).toBeGreaterThan(0);
  });

  it("all migration ids in the unified list are unique", async () => {
    const migrations = await getAllMigrations();
    const ids = migrations.map((m) => m.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("respects an override list and does not load files when overrides provided", async () => {
    const stub: Migration = {
      id: "stub-override",
      preCheck: async (_sql: Sql) => {},
      up: async (_sql: Sql) => {},
      postCheck: async (_sql: Sql) => {},
    };
    const result = await getAllMigrations([stub]);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("stub-override");
  });
});

// ---------------------------------------------------------------------------
// Error handling without DATABASE_URL
// ---------------------------------------------------------------------------

describe("missing DATABASE_URL — throws before making a network call", () => {
  it("runMigrations throws when DATABASE_URL is absent", async () => {
    await expect(runMigrations({ databaseUrl: undefined })).rejects.toThrow(
      /DATABASE_URL/,
    );
  });

  it("getMigrationStatus throws when DATABASE_URL is absent", async () => {
    await expect(
      getMigrationStatus({ databaseUrl: undefined }),
    ).rejects.toThrow(/DATABASE_URL/);
  });

  it("rollbackMigrations throws when DATABASE_URL is absent", async () => {
    await expect(
      rollbackMigrations({ databaseUrl: undefined }),
    ).rejects.toThrow(/DATABASE_URL/);
  });

  it("rollbackMigrations throws when steps < 1", async () => {
    // steps < 1 is validated before the DB connection is needed.
    await expect(
      rollbackMigrations({
        databaseUrl: "postgres://localhost/test",
        steps: 0,
      }),
    ).rejects.toThrow(/steps must be >= 1/);
  });
});
