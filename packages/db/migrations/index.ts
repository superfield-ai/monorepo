/**
 * @file migrations/index.ts
 *
 * Central registry of all database migrations.
 *
 * Migrations are returned in the order they must be applied (numeric file
 * order). Add new migrations here by importing and appending to the list.
 *
 * Each migration module must export a `migration: Migration` object satisfying
 * the contract in packages/db/migrator.ts.
 *
 * Canonical reference: docs/architecture.md §Data Layer; blueprint rule
 * versioned-migration-files (line 1391 of blueprint-data.generated.ts).
 */

import type { Migration } from "../migrator.ts";
import { migration as m0001 } from "./0001_initial_graph.ts";

/**
 * Ordered list of all migrations. The migrator applies them in this order,
 * skipping any that are already recorded in schema_migrations.
 */
export function getMigrations(): Migration[] {
  return [m0001];
}
