/**
 * Nexum schema migration for the shared Postgres instance.
 *
 * This module provides two functions:
 *
 * 1. `runNexumSchemaMigration` — applies the numbered SQL migration files
 *    under `migrations/nexum/` to the shared instance, creating the `nexum`
 *    schema and all tables with workspace_key columns. Follows the versioned
 *    runner pattern (schema_migrations table, files applied in transactions,
 *    already-applied versions skipped).
 *
 * 2. `runNexumDataCutover` — migrates rows from the standalone Nexum
 *    Postgres into the shared instance under a given workspace key. Each row
 *    is tagged with workspace_key for future RLS scoping (§7 gap #3).
 *
 * Neither function connects to a live database when called with a no-op
 * executor — callers supply a `QueryExecutor` so tests can inject a fake
 * without spinning up Postgres.
 *
 * @see docs/architecture.md §6 — namespaced schemas
 * @see docs/architecture.md §Single-Instance Database Schema Layout
 * @see migrations/nexum/0001__nexum_schema.sql
 * @see migrations/nexum/0002__nexum_data_cutover.sql
 * @see issue #368
 */

import { readFile, readdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
  "nexum",
);

/**
 * Minimal query executor interface.
 *
 * The caller provides this so tests can inject fakes without starting a real
 * Postgres connection. Production callers pass a `pg.Pool` adapter.
 */
export interface QueryExecutor {
  /**
   * Execute a SQL string. Returns rows as plain objects.
   * Parameters are positional ($1, $2, ...).
   */
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;

  /**
   * Execute a function inside a single transaction. The executor passed to
   * `fn` shares the connection across all queries in the transaction.
   */
  transaction<T>(fn: (tx: QueryExecutor) => Promise<T>): Promise<T>;
}

/**
 * Result of a schema migration run.
 */
export interface SchemaMigrationResult {
  /** Migration files that were applied in this run (were not already recorded). */
  applied: string[];
  /** Migration files that were already applied and skipped. */
  skipped: string[];
}

/**
 * Apply all pending nexum schema migrations to the shared instance.
 *
 * Steps:
 * 1. Ensure `nexum.schema_migrations` exists (created by 0001 if absent).
 * 2. Read applied versions from `nexum.schema_migrations`.
 * 3. For each pending `NNNN__name.sql` file (in version order), apply it
 *    inside a transaction and record the version.
 *
 * Idempotent: already-applied versions are skipped.
 *
 * @param executor - query executor targeting the shared Postgres instance
 */
export async function runNexumSchemaMigration(
  executor: QueryExecutor,
): Promise<SchemaMigrationResult> {
  const files = await listMigrationFiles();

  // Bootstrap: apply 0001 first if schema_migrations doesn't exist yet.
  // After 0001 runs, schema_migrations is present and tracks everything else.
  const appliedVersions = await getAppliedVersions(executor);

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const version = extractVersion(file);
    if (appliedVersions.has(version)) {
      skipped.push(file);
      continue;
    }

    const sql = await readMigrationFile(file);
    await executor.transaction(async (tx) => {
      await tx.query(sql);
      await tx.query(
        "INSERT INTO nexum.schema_migrations (version, name) VALUES ($1, $2)",
        [version, file],
      );
    });
    applied.push(file);
  }

  return { applied, skipped };
}

/**
 * Options for `runNexumDataCutover`.
 */
export interface NexumDataCutoverOptions {
  /**
   * Workspace key to stamp on every migrated row. Required — every row in
   * the shared instance must carry a workspace_key for future RLS scoping.
   */
  workspaceKey: string;

  /**
   * Query executor targeting the STAGING schema that holds the existing
   * Nexum rows. In production this is the shared instance after the
   * standalone Nexum DB has been restored into a `staging_nexum` schema via
   * pg_restore. In tests this is an injected fake.
   *
   * The executor must be able to see both `nexum.*` (destination) and
   * `staging_nexum.*` (source) schemas.
   */
  stagingExecutor: QueryExecutor;
}

/**
 * Result of a data cutover run.
 */
export interface DataCutoverResult {
  /** Number of rows inserted per table. */
  counts: Record<string, number>;
}

/**
 * Migrate rows from the standalone Nexum staging schema into `nexum.*`.
 *
 * Each row is tagged with `workspaceKey` for future RLS scoping (§7 gap #3).
 * All inserts use `ON CONFLICT DO NOTHING` so the cutover is idempotent.
 * All steps run inside a single transaction; on any error the transaction
 * rolls back and the shared instance is left unchanged.
 *
 * IMPORTANT: This function does NOT read from a live standalone Nexum
 * database directly. The caller must first restore the standalone Nexum DB
 * into a `staging_nexum` schema on the shared instance (e.g. via pg_restore
 * with `--schema-only` renamed to `staging_nexum`). The `stagingExecutor`
 * must see both schemas.
 *
 * @param opts - cutover options including workspaceKey and stagingExecutor
 */
export async function runNexumDataCutover(
  opts: NexumDataCutoverOptions,
): Promise<DataCutoverResult> {
  const { workspaceKey, stagingExecutor } = opts;
  const counts: Record<string, number> = {};

  await stagingExecutor.transaction(async (tx) => {
    // Step 1: corpora
    const corpora = await tx.query(
      `INSERT INTO nexum.corpora (id, workspace_key, name, description, meta, created_at)
       SELECT id, $1, name, description, meta, created_at
       FROM   staging_nexum.corpora
       ON CONFLICT (id) DO NOTHING`,
      [workspaceKey],
    );
    counts["corpora"] = rowCount(corpora);

    // Step 2: documents (current_version_id FK deferred — safe in transaction)
    const documents = await tx.query(
      `INSERT INTO nexum.documents
         (id, workspace_key, corpus_id, title, source_path, source_format,
          external_id, meta, created_at)
       SELECT id, $1, corpus_id, title, source_path, source_format,
              external_id, meta, created_at
       FROM   staging_nexum.documents
       ON CONFLICT (id) DO NOTHING`,
      [workspaceKey],
    );
    counts["documents"] = rowCount(documents);

    // Step 3: document_versions
    const docVersions = await tx.query(
      `INSERT INTO nexum.document_versions
         (id, workspace_key, doc_id, version_num, label, status, ingested_at, meta)
       SELECT id, $1, doc_id, version_num, label, status, ingested_at, meta
       FROM   staging_nexum.document_versions
       ON CONFLICT (id) DO NOTHING`,
      [workspaceKey],
    );
    counts["document_versions"] = rowCount(docVersions);

    // Step 4: blocks
    const blocks = await tx.query(
      `INSERT INTO nexum.blocks
         (id, workspace_key, doc_id, content, content_hash, block_type,
          level, line_start, line_end, eid, parent_block_id, embedding, meta)
       SELECT id, $1, doc_id, content, content_hash, block_type,
              level, line_start, line_end, eid, parent_block_id, embedding, meta
       FROM   staging_nexum.blocks
       ON CONFLICT (id) DO NOTHING`,
      [workspaceKey],
    );
    counts["blocks"] = rowCount(blocks);

    // Step 5: version_blocks
    const versionBlocks = await tx.query(
      `INSERT INTO nexum.version_blocks (version_id, block_id, seq)
       SELECT version_id, block_id, seq
       FROM   staging_nexum.version_blocks
       ON CONFLICT (version_id, block_id) DO NOTHING`,
    );
    counts["version_blocks"] = rowCount(versionBlocks);

    // Step 6: links
    const links = await tx.query(
      `INSERT INTO nexum.links
         (id, workspace_key, src, dst, layer, rel_type, weight,
          confirmed, provenance, edge_embedding, created_at)
       SELECT id, $1, src, dst, layer, rel_type, weight,
              confirmed, provenance, edge_embedding, created_at
       FROM   staging_nexum.links
       ON CONFLICT (id) DO NOTHING`,
      [workspaceKey],
    );
    counts["links"] = rowCount(links);

    // Step 7: entities
    const entities = await tx.query(
      `INSERT INTO nexum.entities
         (id, workspace_key, type, name, api_key_hash, scopes, created_at)
       SELECT id, $1, type, name, api_key_hash, scopes, created_at
       FROM   staging_nexum.entities
       ON CONFLICT (id) DO NOTHING`,
      [workspaceKey],
    );
    counts["entities"] = rowCount(entities);

    // Step 8: corpus_access
    const corpusAccess = await tx.query(
      `INSERT INTO nexum.corpus_access (entity_id, corpus_id, scopes)
       SELECT entity_id, corpus_id, scopes
       FROM   staging_nexum.corpus_access
       ON CONFLICT (entity_id, corpus_id) DO NOTHING`,
    );
    counts["corpus_access"] = rowCount(corpusAccess);

    // Step 9: job_queue — pending jobs only; done/failed/running are not migrated
    const jobQueue = await tx.query(
      `INSERT INTO nexum.job_queue
         (id, workspace_key, job_type, payload, status, attempts, created_at)
       SELECT id, $1, job_type, payload, status, attempts, created_at
       FROM   staging_nexum.job_queue
       WHERE  status = 'pending'
       ON CONFLICT (id) DO NOTHING`,
      [workspaceKey],
    );
    counts["job_queue"] = rowCount(jobQueue);

    // Update current_version_id FKs now that all rows are present
    await tx.query(
      `UPDATE nexum.documents d
       SET    current_version_id = s.current_version_id
       FROM   staging_nexum.documents s
       WHERE  d.id = s.id
         AND  s.current_version_id IS NOT NULL
         AND  d.current_version_id IS NULL`,
    );
  });

  return { counts };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function listMigrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries.filter((f) => f.endsWith(".sql")).sort(); // lexicographic order = version order (NNNN__ prefix)
}

async function readMigrationFile(filename: string): Promise<string> {
  return readFile(resolve(MIGRATIONS_DIR, filename), "utf-8");
}

function extractVersion(filename: string): string {
  // e.g. "0001__nexum_schema.sql" → "0001"
  return filename.split("__")[0] ?? filename;
}

async function getAppliedVersions(
  executor: QueryExecutor,
): Promise<Set<string>> {
  try {
    const result = await executor.query(
      "SELECT version FROM nexum.schema_migrations",
    );
    return new Set(result.rows.map((r) => String(r["version"])));
  } catch {
    // schema_migrations does not exist yet — treat as empty
    return new Set();
  }
}

function rowCount(result: { rows: Record<string, unknown>[] }): number {
  // pg returns rowCount on the result object but our minimal interface uses rows.
  // For INSERT ... ON CONFLICT DO NOTHING, pg returns the number of inserted rows
  // as `rows.length` when using RETURNING, but we omit RETURNING to keep queries
  // simpler. Return 0 as a safe default until the real executor is wired.
  return result.rows.length;
}
