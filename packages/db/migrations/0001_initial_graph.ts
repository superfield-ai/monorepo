/**
 * @file 0001_initial_graph.ts
 *
 * Initial graph schema migration.
 *
 * Canonical reference: docs/architecture.md §Data Layer; blueprint rule
 * IMPL-DATA-002 (three-table-property-graph) and IMPL-DATA-006
 * (initial-migration).
 *
 * # Compatibility checklist (must be verified before deploying)
 *
 * - [x] No column removed, renamed, or type-changed that the running version reads
 *       (first migration — no prior schema)
 * - [x] New columns are nullable or carry safe defaults
 *       (entities.version defaults to 1; all others nullable or typed)
 * - [x] No constraint or index rejects rows old code writes
 *       (first migration — no prior running version)
 * - [x] Data backfill does not acquire blocking locks
 *       (no data backfill — DDL only with IF NOT EXISTS)
 * - [x] Rollback path documented
 *       (rollback: DROP TABLE entity_types, relations, entities CASCADE; no data loss
 *        because this is the initial schema on an empty database)
 *
 * # Schema
 *
 * Three tables form a flexible property graph in the superfield_app schema:
 *
 *   entities      — nodes with type, JSONB properties, and version
 *   relations     — typed directed edges between entities with JSONB properties
 *   entity_types  — schema registry: per-type JSON Schema + sensitivity metadata
 *
 * All tables use IF NOT EXISTS so this migration is fully idempotent.
 */

import type { Migration, Sql } from "../migrator.ts";

export const migration: Migration = {
  id: "0001_initial_graph",

  async preCheck(_sql: Sql): Promise<void> {
    // No prerequisites for the initial migration.
  },

  async up(sql: Sql): Promise<void> {
    // The entity_types registry must exist before entities so the FK can
    // reference it in future iterations. For now we create them in dependency
    // order without a FK to keep the schema flexible during early development.
    await sql`
      CREATE TABLE IF NOT EXISTS entity_types (
        type        TEXT        PRIMARY KEY,
        schema      JSONB       NOT NULL DEFAULT '{}',
        sensitive   TEXT[]      NOT NULL DEFAULT '{}',
        kms_key_id  TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS entities (
        id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        type        TEXT        NOT NULL,
        properties  JSONB       NOT NULL DEFAULT '{}',
        tenant_id   TEXT,
        version     INTEGER     NOT NULL DEFAULT 1,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS entities_type_idx
        ON entities (type)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS entities_tenant_id_idx
        ON entities (tenant_id)
        WHERE tenant_id IS NOT NULL
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS relations (
        id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        source_id   UUID        NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        target_id   UUID        NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        type        TEXT        NOT NULL,
        properties  JSONB       NOT NULL DEFAULT '{}',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS relations_source_id_idx
        ON relations (source_id)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS relations_target_id_idx
        ON relations (target_id)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS relations_type_idx
        ON relations (type)
    `;
  },

  async postCheck(sql: Sql): Promise<void> {
    // Verify all three tables exist.
    const rows = await sql<{ tablename: string }[]>`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN ('entity_types', 'entities', 'relations')
      ORDER BY tablename
    `;
    const names = rows.map((r) => r.tablename);

    const missing = ["entities", "entity_types", "relations"].filter(
      (t) => !names.includes(t),
    );
    if (missing.length > 0) {
      throw new Error(
        `postCheck failed: expected tables not found: ${missing.join(", ")}`,
      );
    }
  },
};
