/**
 * Integration tests for the Nexum schema migration and data cutover.
 *
 * These tests exercise `runNexumSchemaMigration` and `runNexumDataCutover`
 * against a real ephemeral Postgres container (pgvector/pgvector:pg16 image
 * required for vector and pgcrypto extensions).
 *
 * Test plan items (issue #368):
 *   - Integration test: migrate a seeded Nexum DB and assert row parity
 *   - Integration test: migrated rows are workspace-isolated under RLS
 *
 * All test cases are declared as `it.todo()` stubs. They will be converted
 * to real failing tests by the feature agent that implements the unified
 * migration runner (tracked separately in the Plan).
 *
 * @see packages/db/nexum-migration.ts
 * @see packages/db/migrations/nexum/0001__nexum_schema.sql
 * @see packages/db/migrations/nexum/0002__nexum_data_cutover.sql
 * @see issue #368
 */

import { describe, it } from "vitest";

describe("runNexumSchemaMigration — schema creation in shared instance (#368)", () => {
  it.todo(
    "creates nexum schema and all tables when run against a fresh database",
  );

  it.todo("records each applied migration version in nexum.schema_migrations");

  it.todo(
    "is idempotent: re-running skips already-applied migrations without error",
  );

  it.todo(
    "blocks.embedding column has dimension 384 matching the governed model",
  );

  it.todo(
    "links.edge_embedding column has dimension 384 matching blocks.embedding",
  );

  it.todo(
    "all tables have a workspace_key TEXT NOT NULL column for future RLS",
  );
});

describe("runNexumDataCutover — data migration with workspace key (#368)", () => {
  it.todo(
    "migrates a seeded staging_nexum DB into nexum.* with row parity: same IDs and content",
  );

  it.todo("stamps every migrated row with the supplied workspaceKey");

  it.todo(
    "is idempotent: re-running the cutover with the same source does not duplicate rows",
  );

  it.todo("skips job_queue rows that are not in pending status");

  it.todo(
    "rolls back all inserts if any step fails, leaving the shared instance unchanged",
  );

  it.todo(
    "restores current_version_id FK on documents after all versions are migrated",
  );
});

describe("nexum.* workspace isolation — RLS groundwork (#368, §7 gap #3)", () => {
  it.todo(
    "rows with workspace_key='ws-a' are not returned when app.current_workspace_key is 'ws-b'",
  );

  it.todo(
    "two workspaces can hold corpora with the same name without collision",
  );
});
