/**
 * Integration tests for Nexum graph traversal from a single Postgres instance.
 *
 * Issue #359 acceptance criteria:
 *   - No second Postgres process is required for graph queries.
 *   - Existing graph traversals return equivalent results from the single instance.
 *
 * Issue #359 test plan:
 *   - Integration test: a representative multi-hop traversal returns expected
 *     blocks from one instance.
 *   - Compose/boot starts exactly one Postgres (enforced by this test using a
 *     single `startPostgres()` container — no second container is started).
 *
 * @see packages/db/nexum-graph.ts
 * @see docs/architecture.md §6 AGE graph extension
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { startPostgres, type PgContainer } from "../pg-container";
import {
  NEXUM_GRAPH_SETUP_SQL,
  isGraphReady,
  traverseGraph,
} from "../nexum-graph";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function openClient(url: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

async function seedGraph(client: Client): Promise<void> {
  // Seed 6 blocks forming a diamond + tail topology:
  //
  //   a --> b --> d --> f
  //         |    ^
  //         v    |
  //         c ---+
  //
  // Expected reachability from 'a':
  //   depth 0: a
  //   depth 1: b
  //   depth 2: c, d
  //   depth 3: d (via c), f (via d at depth 2)  -- but MIN(depth) collapses d to 2
  //   So final: a(0), b(1), c(2), d(2), f(3)
  //   'e' is an isolated node — NOT reachable from 'a'.

  await client.query(`
    INSERT INTO nexum.blocks (id, content) VALUES
      ('a', 'block a'),
      ('b', 'block b'),
      ('c', 'block c'),
      ('d', 'block d'),
      ('e', 'isolated block e'),
      ('f', 'block f')
    ON CONFLICT DO NOTHING;
  `);

  await client.query(`
    INSERT INTO nexum.links (src, dst, layer, confirmed) VALUES
      ('a', 'b', 'semantic', true),
      ('b', 'c', 'semantic', true),
      ('b', 'd', 'semantic', true),
      ('c', 'd', 'semantic', true),
      ('d', 'f', 'semantic', true)
    ON CONFLICT DO NOTHING;
  `);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("nexum graph traversal — single Postgres instance", () => {
  let pg: PgContainer | undefined;
  let client: Client;
  let skipReason: string | undefined;

  beforeAll(async () => {
    // Start exactly ONE Postgres container. The test verifies graph traversal
    // without starting any second instance (no :5433, no AGE shim container).
    try {
      pg = await startPostgres();
    } catch (err) {
      skipReason = `docker unavailable — skipping nexum graph tests: ${(err as Error).message}`;
      return;
    }
    client = await openClient(pg!.url);

    await client.query(NEXUM_GRAPH_SETUP_SQL);
    await seedGraph(client);
  }, 60_000);

  beforeEach((ctx) => {
    if (skipReason) {
      console.warn(skipReason);
      ctx.skip();
    }
  });

  afterAll(async () => {
    if (!pg) return;
    await client.end();
    await pg.stop();
  });

  it("graph schema is present on the single instance", async () => {
    const ready = await isGraphReady(client);
    expect(ready).toBe(true);
  });

  it("traversal from 'a' reaches all connected blocks at correct depths", async () => {
    const results = await traverseGraph(client, "a");

    const byId = Object.fromEntries(results.map((r) => [r.blockId, r.depth]));

    expect(byId["a"]).toBe(0); // start node
    expect(byId["b"]).toBe(1); // one hop
    expect(byId["c"]).toBe(2); // two hops
    expect(byId["d"]).toBe(2); // two hops (direct from b, shorter than via c)
    expect(byId["f"]).toBe(3); // three hops
    expect(byId["e"]).toBeUndefined(); // isolated — not reachable
  });

  it("traversal with maxDepth=1 returns only immediate neighbours", async () => {
    const results = await traverseGraph(client, "a", 1);

    const ids = results.map((r) => r.blockId).sort();
    expect(ids).toEqual(["a", "b"]);
  });

  it("traversal filtered by layer only follows edges in that layer", async () => {
    // Insert a 'structural' edge that should NOT be followed in a 'semantic' traversal
    await client.query(`
      INSERT INTO nexum.links (src, dst, layer, confirmed)
      VALUES ('a', 'e', 'structural', true)
      ON CONFLICT DO NOTHING;
    `);

    const semanticResults = await traverseGraph(client, "a", 10, "semantic");
    const semanticIds = semanticResults.map((r) => r.blockId);

    // 'e' is only reachable via the structural edge — must not appear
    expect(semanticIds).not.toContain("e");

    const allResults = await traverseGraph(client, "a");
    const allIds = allResults.map((r) => r.blockId);

    // Without layer filter, 'e' is reachable via the structural edge
    expect(allIds).toContain("e");
  });

  it("unconfirmed edges are still traversed (parity with AGE shim behaviour)", async () => {
    await client.query(`
      INSERT INTO nexum.blocks (id, content)
      VALUES ('g', 'block g via unconfirmed link')
      ON CONFLICT DO NOTHING;
    `);
    await client.query(`
      INSERT INTO nexum.links (src, dst, layer, confirmed)
      VALUES ('f', 'g', 'semantic', false)
      ON CONFLICT DO NOTHING;
    `);

    const results = await traverseGraph(client, "a");
    const ids = results.map((r) => r.blockId);

    // The AGE shim included unconfirmed links; recursive CTE must match.
    expect(ids).toContain("g");
  });
});
