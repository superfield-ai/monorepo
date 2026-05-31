/**
 * Nexum graph traversal — single-instance implementation.
 *
 * Replaces the Apache AGE shim that previously required a second Postgres
 * process on :5433. Graph traversal is now served from the primary Postgres
 * instance using recursive CTEs over the `nexum.links` table.
 *
 * Schema (must be applied before use):
 *   - `nexum` schema
 *   - `nexum.blocks` — graph nodes (id, content)
 *   - `nexum.links`  — directed edges (src, dst, layer, weight, confirmed)
 *
 * Decision: AGE-in-instance vs recursive CTEs
 *   Apache AGE requires a patched Postgres build. The standard Postgres 16
 *   image used everywhere in this stack does not ship AGE. Recursive CTEs
 *   over `nexum.links` deliver equivalent multi-hop traversal on any stock
 *   Postgres 14+ instance, with no patched binary required. AGE-in-instance
 *   remains the long-term target if graph query volume demands Cypher, but
 *   recursive CTEs satisfy the current parity requirement and unblock
 *   elimination of the second Postgres process.
 *
 * @see docs/architecture.md §6 AGE graph extension (Gap #2, now closed)
 */

import type { Client } from "pg";

export interface GraphEdge {
  src: string;
  dst: string;
  layer: string;
  weight: number | null;
  confirmed: boolean | null;
}

export interface GraphTraversalResult {
  blockId: string;
  depth: number;
}

/**
 * SQL that creates the `nexum` schema and the minimal tables required for
 * graph traversal. Apply this once during Nexum migration bootstrap.
 *
 * This replaces `nexum/db/migrations/0001_age_shim.sql` and removes the
 * dependency on a second Postgres process at :5433.
 */
export const NEXUM_GRAPH_SETUP_SQL = `
CREATE SCHEMA IF NOT EXISTS nexum;

CREATE TABLE IF NOT EXISTS nexum.blocks (
  id      TEXT PRIMARY KEY,
  content TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS nexum.links (
  id        BIGSERIAL PRIMARY KEY,
  src       TEXT NOT NULL REFERENCES nexum.blocks(id),
  dst       TEXT NOT NULL REFERENCES nexum.blocks(id),
  layer     TEXT NOT NULL DEFAULT 'semantic',
  weight    NUMERIC,
  confirmed BOOLEAN
);

CREATE INDEX IF NOT EXISTS nexum_links_src_idx ON nexum.links(src);
CREATE INDEX IF NOT EXISTS nexum_links_dst_idx ON nexum.links(dst);
CREATE INDEX IF NOT EXISTS nexum_links_layer_idx ON nexum.links(layer);
`.trim();

/**
 * Traverse the `nexum.links` graph up to `maxDepth` hops from `startBlockId`,
 * following edges in the given `layer` (default: all layers).
 *
 * Returns every reachable block together with the minimum depth at which it
 * was reached. Uses a recursive CTE — no Apache AGE required.
 *
 * @param client   Connected `pg.Client` pointing at the primary Postgres instance.
 * @param startBlockId  The block id to start traversal from.
 * @param maxDepth  Maximum number of hops (default: 10).
 * @param layer     If provided, only follow edges with this layer value.
 */
export async function traverseGraph(
  client: Client,
  startBlockId: string,
  maxDepth = 10,
  layer?: string,
): Promise<GraphTraversalResult[]> {
  const layerClause = layer
    ? "AND l.layer = $3"
    : "AND ($3::text IS NULL OR l.layer = $3)";

  const query = `
    WITH RECURSIVE reachable(block_id, depth) AS (
      -- Base: the start node at depth 0
      SELECT $1::text AS block_id, 0 AS depth

      UNION

      -- Recursive: follow outgoing links one hop at a time
      SELECT l.dst AS block_id, r.depth + 1 AS depth
      FROM   reachable r
      JOIN   nexum.links l ON l.src = r.block_id
      WHERE  r.depth < $2
             ${layerClause}
    )
    SELECT block_id, MIN(depth) AS depth
    FROM   reachable
    GROUP  BY block_id
    ORDER  BY depth, block_id;
  `;

  const result = await client.query<{ block_id: string; depth: number }>(
    query,
    [startBlockId, maxDepth, layer ?? null],
  );

  return result.rows.map((row) => ({
    blockId: row.block_id,
    depth: row.depth,
  }));
}

/**
 * Verify that the Nexum graph schema is present and the `nexum.links` table
 * exists on the given connection. Returns `true` when the single-instance
 * graph tables are available, `false` otherwise.
 *
 * Callers that previously connected to `:5433` should switch to checking this
 * function instead.
 */
export async function isGraphReady(client: Client): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE  table_schema = 'nexum'
        AND  table_name   = 'links'
    ) AS exists
  `);
  return result.rows[0]?.exists === true;
}
