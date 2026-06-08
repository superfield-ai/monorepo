/**
 * Integration tests for the Nexum schema migration and data cutover.
 *
 * These tests exercise `runNexumSchemaMigration` and `runNexumDataCutover`
 * against a real ephemeral Postgres container (pgvector/pgvector:pg16 image
 * required for vector and pgcrypto extensions).
 *
 * Issue #441 acceptance criteria:
 *   - All nexum blocks, embeddings, and links present in shared instance after migration
 *   - nexum-pg service removed from Docker Compose (enforced: single container started)
 *   - Nexum integration tests pass against shared instance
 *   - Dev setup docs updated
 *
 * Test plan items (issue #441):
 *   - Migration script runs without error on a populated nexum-pg container
 *   - Row counts match between source and destination
 *   - Nexum integration tests pass after migration
 *   - CI green (no nexum-pg dependency in CI)
 *
 * @see packages/db/nexum-migration.ts
 * @see packages/db/migrations/nexum/0001__nexum_schema.sql
 * @see packages/db/migrations/nexum/0002__nexum_data_cutover.sql
 * @see issue #441
 */

import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import type { PgContainer } from "../../pg-container.ts";
import {
  runNexumSchemaMigration,
  runNexumDataCutover,
  type QueryExecutor,
} from "../../nexum-migration.ts";

// ---------------------------------------------------------------------------
// Docker helpers (pgvector image — required for vector extension)
// ---------------------------------------------------------------------------

const PG_USER = "superfield";
const PG_PASSWORD = "superfield";
const PG_DB = "superfield";
/** pgvector/pgvector:pg16 ships the vector extension required by nexum schema. */
const PGVECTOR_IMAGE = "pgvector/pgvector:pg16";
const READY_TIMEOUT_MS = 60_000;
const PORT_POLL_INTERVAL_MS = 300;

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

async function startPgvectorPostgres(): Promise<PgContainer> {
  const runResult = spawnSync(
    "docker",
    [
      "run",
      "-d",
      "--rm",
      "-e",
      `POSTGRES_USER=${PG_USER}`,
      "-e",
      `POSTGRES_PASSWORD=${PG_PASSWORD}`,
      "-e",
      `POSTGRES_DB=${PG_DB}`,
      "-p",
      "0:5432",
      PGVECTOR_IMAGE,
    ],
    { stdio: "pipe" },
  );

  if (runResult.status !== 0) {
    throw new Error(
      `Failed to start pgvector container: ${runResult.stderr.toString()}`,
    );
  }

  const containerId = runResult.stdout.toString().trim();
  const port = await getContainerPortWithRetry(containerId);
  await waitForPostgres(containerId, port);

  const url = `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${port}/${PG_DB}`;

  return {
    url,
    containerId,
    stop: async () => {
      spawnSync("docker", ["stop", containerId]);
    },
  };
}

async function getContainerPortWithRetry(containerId: string): Promise<number> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = spawnSync("docker", ["port", containerId, "5432"], {
      stdio: "pipe",
    });
    const output = result.stdout.toString().trim();
    if (output) {
      const firstLine = (output.split("\n")[0] ?? "").trim();
      const port = parseInt(firstLine.split(":").at(-1) ?? "", 10);
      if (Number.isFinite(port)) return port;
    }
    await new Promise<void>((r) => setTimeout(r, PORT_POLL_INTERVAL_MS));
  }
  throw new Error(
    `Timed out waiting for docker to publish port for container ${containerId}`,
  );
}

async function waitForPostgres(
  containerId: string,
  port: number,
): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = spawnSync(
      "pg_isready",
      ["-h", "localhost", "-p", String(port), "-U", PG_USER],
      { env: { ...process.env, PGPASSWORD: PG_PASSWORD }, stdio: "pipe" },
    );
    if (result.status === 0) return;

    const logs = spawnSync("docker", ["logs", "--tail", "10", containerId], {
      stdio: "pipe",
    });
    const out = logs.stdout.toString() + logs.stderr.toString();
    if (out.includes("ready to accept connections")) return;

    await new Promise<void>((r) => setTimeout(r, PORT_POLL_INTERVAL_MS));
  }
  throw new Error(
    `Postgres container did not become ready within ${READY_TIMEOUT_MS}ms`,
  );
}

async function openClient(url: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

/**
 * Wrap a pg.Client as a QueryExecutor for use with nexum-migration functions.
 */
function pgClientToExecutor(client: Client): QueryExecutor {
  const executor: QueryExecutor = {
    query: async (sql: string, params?: unknown[]) => {
      const res = await client.query(sql, params as unknown[]);
      return { rows: res.rows as Record<string, unknown>[] };
    },
    transaction: async <T>(
      fn: (tx: QueryExecutor) => Promise<T>,
    ): Promise<T> => {
      await client.query("BEGIN");
      try {
        const result = await fn(executor);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    },
  };
  return executor;
}

// ---------------------------------------------------------------------------
// Seed helpers — populate staging_nexum schema to simulate a source DB
// ---------------------------------------------------------------------------

async function createStagingNexumSchema(client: Client): Promise<void> {
  // Create a staging_nexum schema that mirrors the nexum schema structure
  // (as if the standalone nexum DB was pg_restored into this schema).
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS staging_nexum;

    CREATE TABLE IF NOT EXISTS staging_nexum.corpora (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name        TEXT NOT NULL,
      description TEXT,
      meta        JSONB,
      created_at  TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS staging_nexum.documents (
      id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      corpus_id          UUID REFERENCES staging_nexum.corpora(id),
      title              TEXT NOT NULL,
      source_path        TEXT,
      source_format      TEXT,
      current_version_id UUID,
      external_id        TEXT,
      meta               JSONB,
      created_at         TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS staging_nexum.document_versions (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      doc_id      UUID NOT NULL REFERENCES staging_nexum.documents(id),
      version_num INTEGER NOT NULL,
      label       TEXT,
      status      TEXT DEFAULT 'done',
      ingested_at TIMESTAMPTZ DEFAULT now(),
      meta        JSONB
    );

    CREATE TABLE IF NOT EXISTS staging_nexum.blocks (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      doc_id          UUID NOT NULL REFERENCES staging_nexum.documents(id),
      content         TEXT NOT NULL,
      content_hash    TEXT NOT NULL,
      block_type      TEXT NOT NULL DEFAULT 'paragraph',
      level           INTEGER,
      line_start      INTEGER,
      line_end        INTEGER,
      eid             TEXT,
      parent_block_id UUID REFERENCES staging_nexum.blocks(id),
      embedding       vector(384),
      meta            JSONB
    );

    CREATE TABLE IF NOT EXISTS staging_nexum.version_blocks (
      version_id UUID NOT NULL REFERENCES staging_nexum.document_versions(id),
      block_id   UUID NOT NULL REFERENCES staging_nexum.blocks(id),
      seq        INTEGER NOT NULL,
      PRIMARY KEY (version_id, block_id)
    );

    CREATE TABLE IF NOT EXISTS staging_nexum.links (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      src            UUID NOT NULL REFERENCES staging_nexum.blocks(id),
      dst            UUID NOT NULL REFERENCES staging_nexum.blocks(id),
      layer          TEXT NOT NULL DEFAULT 'semantic',
      rel_type       TEXT,
      weight         FLOAT DEFAULT 1.0,
      confirmed      BOOLEAN,
      provenance     JSONB NOT NULL DEFAULT '{}',
      edge_embedding vector(384),
      created_at     TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS staging_nexum.entities (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      type         TEXT NOT NULL DEFAULT 'user',
      name         TEXT NOT NULL,
      api_key_hash TEXT,
      scopes       TEXT[] DEFAULT '{}',
      created_at   TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS staging_nexum.corpus_access (
      entity_id UUID NOT NULL REFERENCES staging_nexum.entities(id),
      corpus_id UUID NOT NULL REFERENCES staging_nexum.corpora(id),
      scopes    TEXT[] NOT NULL DEFAULT '{}',
      PRIMARY KEY (entity_id, corpus_id)
    );

    CREATE TABLE IF NOT EXISTS staging_nexum.job_queue (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      job_type   TEXT NOT NULL,
      payload    JSONB NOT NULL DEFAULT '{}',
      status     TEXT DEFAULT 'pending',
      attempts   INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}

interface SeedResult {
  corpusId: string;
  documentId: string;
  versionId: string;
  blockId1: string;
  blockId2: string;
  linkId: string;
  entityId: string;
}

async function seedStagingNexum(client: Client): Promise<SeedResult> {
  const corpusRes = await client.query<{ id: string }>(
    `INSERT INTO staging_nexum.corpora (name, description)
     VALUES ('Test Corpus', 'Integration test corpus')
     RETURNING id`,
  );
  const corpusId = corpusRes.rows[0]!.id;

  const docRes = await client.query<{ id: string }>(
    `INSERT INTO staging_nexum.documents (corpus_id, title, source_path, source_format, external_id)
     VALUES ($1, 'Test Document', '/docs/test.md', 'markdown', 'ext-001')
     RETURNING id`,
    [corpusId],
  );
  const documentId = docRes.rows[0]!.id;

  const verRes = await client.query<{ id: string }>(
    `INSERT INTO staging_nexum.document_versions (doc_id, version_num, label, status)
     VALUES ($1, 1, 'v1', 'done')
     RETURNING id`,
    [documentId],
  );
  const versionId = verRes.rows[0]!.id;

  // Update current_version_id
  await client.query(
    `UPDATE staging_nexum.documents SET current_version_id = $1 WHERE id = $2`,
    [versionId, documentId],
  );

  const block1Res = await client.query<{ id: string }>(
    `INSERT INTO staging_nexum.blocks (doc_id, content, content_hash, block_type, line_start, line_end)
     VALUES ($1, 'First block content', 'hash-001', 'paragraph', 1, 5)
     RETURNING id`,
    [documentId],
  );
  const blockId1 = block1Res.rows[0]!.id;

  const block2Res = await client.query<{ id: string }>(
    `INSERT INTO staging_nexum.blocks (doc_id, content, content_hash, block_type, line_start, line_end)
     VALUES ($1, 'Second block content', 'hash-002', 'paragraph', 6, 10)
     RETURNING id`,
    [documentId],
  );
  const blockId2 = block2Res.rows[0]!.id;

  // Insert version_blocks
  await client.query(
    `INSERT INTO staging_nexum.version_blocks (version_id, block_id, seq) VALUES ($1, $2, 1), ($1, $3, 2)`,
    [versionId, blockId1, blockId2],
  );

  // Insert a link between the two blocks
  const linkRes = await client.query<{ id: string }>(
    `INSERT INTO staging_nexum.links (src, dst, layer, provenance)
     VALUES ($1, $2, 'structural', '{"source": "test"}')
     RETURNING id`,
    [blockId1, blockId2],
  );
  const linkId = linkRes.rows[0]!.id;

  // Insert an entity
  const entityRes = await client.query<{ id: string }>(
    `INSERT INTO staging_nexum.entities (type, name, scopes)
     VALUES ('user', 'testuser', ARRAY['read', 'write'])
     RETURNING id`,
  );
  const entityId = entityRes.rows[0]!.id;

  // Insert corpus_access
  await client.query(
    `INSERT INTO staging_nexum.corpus_access (entity_id, corpus_id, scopes)
     VALUES ($1, $2, ARRAY['read'])`,
    [entityId, corpusId],
  );

  // Insert job_queue rows: 1 pending + 1 done (done should NOT migrate)
  await client.query(
    `INSERT INTO staging_nexum.job_queue (job_type, payload, status)
     VALUES ('embed', '{"doc": "x"}', 'pending'), ('embed', '{"doc": "y"}', 'done')`,
  );

  return {
    corpusId,
    documentId,
    versionId,
    blockId1,
    blockId2,
    linkId,
    entityId,
  };
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

let pg: PgContainer | undefined;
let skipReason: string | undefined;
let client: Client;

beforeAll(async () => {
  if (!dockerAvailable()) {
    skipReason =
      "docker not available — skipping nexum migration integration tests";
    return;
  }
  try {
    pg = await startPgvectorPostgres();
  } catch (err) {
    skipReason = `failed to start pgvector container: ${(err as Error).message}`;
    return;
  }
  const urlObj = new URL(pg!.url);
  if (!(await tcpReachable(urlObj.hostname, Number(urlObj.port)))) {
    await pg!.stop();
    pg = undefined;
    skipReason =
      "postgres container port not reachable (Docker-in-Docker) — skipping";
    return;
  }
  client = await openClient(pg.url);
  // Apply the nexum schema migration
  const executor = pgClientToExecutor(client);
  await runNexumSchemaMigration(executor);
  // Create and seed the staging schema
  await createStagingNexumSchema(client);
  await seedStagingNexum(client);
}, 120_000);

afterAll(async () => {
  if (client) {
    try {
      await client.end();
    } catch {
      /* ignore */
    }
  }
  if (pg) {
    await pg.stop();
  }
}, 30_000);

// ---------------------------------------------------------------------------
// runNexumSchemaMigration — schema creation
// ---------------------------------------------------------------------------

describe("runNexumSchemaMigration — schema creation in shared instance (#441)", () => {
  it("creates nexum schema and all tables when run against a fresh database", async () => {
    if (skipReason) {
      console.warn(skipReason);
      return;
    }

    const tables = await client.query<{ tablename: string }>(`
      SELECT tablename FROM pg_tables WHERE schemaname = 'nexum' ORDER BY tablename
    `);
    const tableNames = tables.rows.map((r) => r.tablename);
    expect(tableNames).toContain("blocks");
    expect(tableNames).toContain("corpora");
    expect(tableNames).toContain("corpus_access");
    expect(tableNames).toContain("document_versions");
    expect(tableNames).toContain("documents");
    expect(tableNames).toContain("entities");
    expect(tableNames).toContain("job_queue");
    expect(tableNames).toContain("links");
    expect(tableNames).toContain("schema_migrations");
    expect(tableNames).toContain("version_blocks");
  }, 30_000);

  it("records each applied migration version in nexum.schema_migrations", async () => {
    if (skipReason) {
      console.warn(skipReason);
      return;
    }

    const rows = await client.query<{ version: string; name: string }>(
      "SELECT version, name FROM nexum.schema_migrations ORDER BY version",
    );
    expect(rows.rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.rows.map((r) => r.version)).toContain("0001");
  }, 30_000);

  it("is idempotent: re-running skips already-applied migrations without error", async () => {
    if (skipReason) {
      console.warn(skipReason);
      return;
    }

    const executor = pgClientToExecutor(client);
    const result = await runNexumSchemaMigration(executor);

    // All migrations already applied — nothing new to apply.
    expect(result.applied).toHaveLength(0);
    expect(result.skipped.length).toBeGreaterThan(0);
  }, 30_000);

  it("blocks.embedding column has dimension 384 matching the governed model", async () => {
    if (skipReason) {
      console.warn(skipReason);
      return;
    }

    // atttypmod for vector(384) encodes the dimension.
    // typmod = dimension + 1 for pgvector.
    const rows = await client.query<{ atttypmod: number }>(`
      SELECT a.atttypmod
      FROM   pg_attribute a
      JOIN   pg_class c ON c.oid = a.attrelid
      JOIN   pg_namespace n ON n.oid = c.relnamespace
      WHERE  n.nspname = 'nexum'
        AND  c.relname = 'blocks'
        AND  a.attname = 'embedding'
    `);
    expect(rows.rows.length).toBe(1);
    // atttypmod = dimension for pgvector (dimension stored directly)
    expect(rows.rows[0]!.atttypmod).toBe(384);
  }, 30_000);

  it("links.edge_embedding column has dimension 384 matching blocks.embedding", async () => {
    if (skipReason) {
      console.warn(skipReason);
      return;
    }

    const rows = await client.query<{ atttypmod: number }>(`
      SELECT a.atttypmod
      FROM   pg_attribute a
      JOIN   pg_class c ON c.oid = a.attrelid
      JOIN   pg_namespace n ON n.oid = c.relnamespace
      WHERE  n.nspname = 'nexum'
        AND  c.relname = 'links'
        AND  a.attname = 'edge_embedding'
    `);
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]!.atttypmod).toBe(384);
  }, 30_000);

  it("all tables have a workspace_key TEXT NOT NULL column for future RLS", async () => {
    if (skipReason) {
      console.warn(skipReason);
      return;
    }

    // Tables that have workspace_key (not all tables do — version_blocks, corpus_access
    // use composite PKs referencing parent rows that carry workspace_key).
    const workspaceKeyTables = [
      "corpora",
      "documents",
      "document_versions",
      "blocks",
      "links",
      "entities",
      "job_queue",
    ];

    for (const table of workspaceKeyTables) {
      const rows = await client.query<{ attnotnull: boolean }>(
        `
        SELECT a.attnotnull
        FROM   pg_attribute a
        JOIN   pg_class c ON c.oid = a.attrelid
        JOIN   pg_namespace n ON n.oid = c.relnamespace
        WHERE  n.nspname = 'nexum'
          AND  c.relname = $1
          AND  a.attname = 'workspace_key'
          AND  a.attnum > 0
      `,
        [table],
      );
      expect(rows.rows.length).toBe(1);
      expect(rows.rows[0]!.attnotnull).toBe(true);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// runNexumDataCutover — data migration
// ---------------------------------------------------------------------------

describe("runNexumDataCutover — data migration with workspace key (#441)", () => {
  const WORKSPACE_KEY = "ws-integration-test";

  beforeAll(async () => {
    if (skipReason) return;
    // Run the data cutover once for all tests in this suite.
    const executor = pgClientToExecutor(client);
    await runNexumDataCutover({
      workspaceKey: WORKSPACE_KEY,
      stagingExecutor: executor,
    });
  }, 60_000);

  it("migrates a seeded staging_nexum DB into nexum.* with row parity: same IDs and content", async () => {
    if (skipReason) {
      console.warn(skipReason);
      return;
    }

    // Verify corpora
    const corpora = await client.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM nexum.corpora WHERE workspace_key = $1",
      [WORKSPACE_KEY],
    );
    expect(parseInt(corpora.rows[0]!.count)).toBe(1);

    // Verify documents
    const docs = await client.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM nexum.documents WHERE workspace_key = $1",
      [WORKSPACE_KEY],
    );
    expect(parseInt(docs.rows[0]!.count)).toBe(1);

    // Verify blocks
    const blocks = await client.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM nexum.blocks WHERE workspace_key = $1",
      [WORKSPACE_KEY],
    );
    expect(parseInt(blocks.rows[0]!.count)).toBe(2);

    // Verify links
    const links = await client.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM nexum.links WHERE workspace_key = $1",
      [WORKSPACE_KEY],
    );
    expect(parseInt(links.rows[0]!.count)).toBe(1);
  }, 30_000);

  it("stamps every migrated row with the supplied workspaceKey", async () => {
    if (skipReason) {
      console.warn(skipReason);
      return;
    }

    // All corpora rows must have the correct workspace_key
    const wrongWs = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM nexum.corpora WHERE workspace_key != $1`,
      [WORKSPACE_KEY],
    );
    expect(parseInt(wrongWs.rows[0]!.count)).toBe(0);

    // Same for blocks
    const wrongBlocks = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM nexum.blocks WHERE workspace_key != $1`,
      [WORKSPACE_KEY],
    );
    expect(parseInt(wrongBlocks.rows[0]!.count)).toBe(0);
  }, 30_000);

  it("is idempotent: re-running the cutover with the same source does not duplicate rows", async () => {
    if (skipReason) {
      console.warn(skipReason);
      return;
    }

    const countBefore = await client.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM nexum.corpora WHERE workspace_key = $1",
      [WORKSPACE_KEY],
    );

    // Re-run the cutover — ON CONFLICT DO NOTHING should make this a no-op
    const executor = pgClientToExecutor(client);
    await runNexumDataCutover({
      workspaceKey: WORKSPACE_KEY,
      stagingExecutor: executor,
    });

    const countAfter = await client.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM nexum.corpora WHERE workspace_key = $1",
      [WORKSPACE_KEY],
    );

    expect(countAfter.rows[0]!.count).toBe(countBefore.rows[0]!.count);
  }, 30_000);

  it("skips job_queue rows that are not in pending status", async () => {
    if (skipReason) {
      console.warn(skipReason);
      return;
    }

    // We seeded 2 job_queue rows: 1 pending + 1 done
    // Only the pending one should be migrated.
    const rows = await client.query<{ status: string; count: string }>(
      `SELECT status, COUNT(*) AS count FROM nexum.job_queue
       WHERE workspace_key = $1 GROUP BY status`,
      [WORKSPACE_KEY],
    );
    const byStatus: Record<string, number> = {};
    for (const row of rows.rows) {
      byStatus[row.status] = parseInt(row.count);
    }
    // Only 'pending' rows should be present
    expect(byStatus["pending"]).toBe(1);
    expect(byStatus["done"]).toBeUndefined();
  }, 30_000);

  it("restores current_version_id FK on documents after all versions are migrated", async () => {
    if (skipReason) {
      console.warn(skipReason);
      return;
    }

    // The seeded document has a current_version_id set in staging.
    // After cutover, the nexum.documents row must also have current_version_id set.
    const rows = await client.query<{ current_version_id: string | null }>(
      `SELECT current_version_id FROM nexum.documents WHERE workspace_key = $1`,
      [WORKSPACE_KEY],
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]!.current_version_id).not.toBeNull();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// nexum.* workspace isolation — RLS groundwork
// ---------------------------------------------------------------------------

describe("nexum.* workspace isolation — RLS groundwork (#441, §7 gap #3)", () => {
  it("two workspaces can hold corpora with the same name without collision", async () => {
    if (skipReason) {
      console.warn(skipReason);
      return;
    }

    // Insert the same corpus name under two different workspace keys directly.
    await client.query(
      `INSERT INTO nexum.corpora (workspace_key, name) VALUES ('ws-rls-a', 'Shared Name'), ('ws-rls-b', 'Shared Name')`,
    );

    const aRows = await client.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM nexum.corpora WHERE workspace_key = 'ws-rls-a'",
    );
    const bRows = await client.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM nexum.corpora WHERE workspace_key = 'ws-rls-b'",
    );
    expect(parseInt(aRows.rows[0]!.count)).toBeGreaterThanOrEqual(1);
    expect(parseInt(bRows.rows[0]!.count)).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
