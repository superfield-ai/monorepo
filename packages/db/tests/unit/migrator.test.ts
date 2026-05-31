/**
 * @file migrator.test.ts
 *
 * Unit tests for the migration registry and migration contract.
 *
 * These tests verify structural invariants of the migration list without
 * requiring a live Postgres instance or Docker.
 */

import { describe, expect, it } from "vitest";
import { getMigrations } from "../../migrations/index.ts";

describe("getMigrations", () => {
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
