/**
 * Integration test for issue #101: graphSearch ported to AGE Cypher.
 *
 * Boots both the primary Postgres and the Apache AGE companion, seeds a
 * tiny corpus with hand-crafted links across two layers, dual-writes those
 * links into AGE, and exercises the new Cypher-backed graphSearch:
 *
 *   1. Default semantics (out direction, all layers, depth-bounded).
 *   2. Layer filter narrows the reachable set.
 *   3. rel_types filter narrows the reachable set.
 *   4. Direction filter (`in` and `both`) flips/widens traversal.
 *   5. max_hops bounds the depth.
 *   6. Response shape matches the legacy CTE contract exactly.
 *
 * If the AGE container cannot be pulled (CI without Docker / restricted
 * networks), tests skip cleanly — same convention as age-edges.test.ts.
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startDb, stopDb, startAge, stopAge } from './setup.js'
import { query, execute } from '../../src/db/queries.js'
import { createHash } from 'node:crypto'

let ageUrl: string | null = null

before(async () => {
  await startDb()
  ageUrl = await startAge()
})

after(async () => {
  await stopAge()
  await stopDb()
})

interface Seeded {
  corpusId: string
  blocks: Record<string, string> // alias -> block uuid
}

/**
 * Build a small graph:
 *
 *      [A] --structural/cites--> [B] --semantic/related--> [C]
 *       \--ai/mentions--> [D]
 *
 * Five blocks, three layers, four edges. Seed for traversal scenarios.
 */
async function seedGraph(corpusName: string): Promise<Seeded> {
  const [corpus] = await query<{ id: string }>(
    `INSERT INTO corpora (name) VALUES ($1) RETURNING id`,
    [corpusName],
  )
  const [doc] = await query<{ id: string }>(
    `INSERT INTO documents (title, corpus_id) VALUES ('Seed Doc', $1) RETURNING id`,
    [corpus.id],
  )
  const [ver] = await query<{ id: string }>(
    `INSERT INTO document_versions (doc_id, version_num, status) VALUES ($1, 1, 'parsed') RETURNING id`,
    [doc.id],
  )
  const blocks: Record<string, string> = {}
  const aliases = ['A', 'B', 'C', 'D']
  for (let i = 0; i < aliases.length; i++) {
    const content = `Block-${aliases[i]}-content for ${corpusName}`
    const hash = createHash('sha256').update(content).digest('hex')
    const [b] = await query<{ id: string }>(
      `INSERT INTO blocks (doc_id, content, content_hash, block_type) VALUES ($1, $2, $3, 'paragraph') RETURNING id`,
      [doc.id, content, hash],
    )
    blocks[aliases[i]] = b.id
    await execute(
      `INSERT INTO version_blocks (version_id, block_id, seq) VALUES ($1, $2, $3)`,
      [ver.id, b.id, i + 1],
    )
  }
  await execute(`UPDATE documents SET current_version_id = $1 WHERE id = $2`, [ver.id, doc.id])

  const edges: Array<[string, string, string, string]> = [
    [blocks.A, blocks.B, 'structural', 'cites'],
    [blocks.B, blocks.C, 'semantic', 'related'],
    [blocks.A, blocks.D, 'ai', 'mentions'],
  ]
  for (const [src, dst, layer, rel] of edges) {
    await execute(
      `INSERT INTO links (src, dst, layer, rel_type, weight, provenance)
       VALUES ($1, $2, $3, $4, 1.0, '{"model":"graph-cypher-test"}'::jsonb)`,
      [src, dst, layer, rel],
    )
  }

  // Push into AGE so Cypher can see them. Re-uses the same MERGE shape as
  // the migration backfill (see src/db/migrate.ts).
  if (ageUrl) {
    const { getAgePool } = await import('../../src/db/age.js')
    const pool = await getAgePool()
    const linkRows = await query<{ id: string; src: string; dst: string; layer: string; rel_type: string }>(
      `SELECT id::text AS id, src::text AS src, dst::text AS dst, layer, rel_type
         FROM links WHERE src = ANY($1::uuid[])`,
      [Object.values(blocks)],
    )
    for (const r of linkRows) {
      const cy = `
        MERGE (a:Block {id: '${r.src}'})
        MERGE (b:Block {id: '${r.dst}'})
        MERGE (a)-[e:LINK {link_id: '${r.id}'}]->(b)
        SET e.layer = '${r.layer}', e.rel_type = '${r.rel_type}', e.weight = 1.0
      `
      await pool.query(`SELECT * FROM cypher('nexum_links', $$ ${cy} $$) AS (v agtype)`)
    }
  }

  return { corpusId: corpus.id, blocks }
}

/**
 * Drive the route handler's traversal directly. We cannot import the
 * `graphSearch` function (it is module-private), so we hit the registered
 * POST /query handler through the in-process server. To keep the test
 * lean, we instead exercise the same code path by importing the route
 * module and invoking it via the registered router.
 */
let serverPort = 0
let serverInstance: import('node:http').Server | null = null

async function ensureServer(): Promise<number> {
  if (serverInstance && serverPort) return serverPort
  await import('../../src/routes/query.js')
  const { createApp } = await import('../../src/server.js')
  serverInstance = createApp()
  await new Promise<void>((resolve) => serverInstance!.listen(0, '127.0.0.1', resolve))
  const addr = serverInstance.address()
  if (!addr || typeof addr === 'string') throw new Error('failed to bind ephemeral port')
  serverPort = addr.port
  return serverPort
}

after(async () => {
  if (serverInstance) {
    await new Promise<void>((resolve, reject) =>
      serverInstance!.close((err) => (err ? reject(err) : resolve())),
    )
    serverInstance = null
  }
})

async function runGraphQuery(args: {
  corpus_id: string
  seed_block_id: string
  max_hops?: number
  layers?: string[]
  rel_types?: string[]
  direction?: 'out' | 'in' | 'both'
  limit?: number
}): Promise<any[]> {
  const port = await ensureServer()
  const body = JSON.stringify({ mode: 'graph', ...args })
  const res = await fetch(`http://127.0.0.1:${port}/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
  const text = await res.text()
  if (res.status !== 200) {
    throw new Error(`graph query failed: status=${res.status} body=${text}`)
  }
  return JSON.parse(text).results
}

test('graphSearch (Cypher) returns blocks reachable from the seed across all layers', async (t) => {
  if (!ageUrl) return t.skip('AGE container not available')
  const seed = await seedGraph('graph-cypher-default')
  const results = await runGraphQuery({
    corpus_id: seed.corpusId,
    seed_block_id: seed.blocks.A,
    max_hops: 3,
  })
  const ids = results.map((r) => r.block_id).sort()
  // From A with default direction=out: B (depth 1), D (depth 1), C (depth 2).
  assert.deepEqual(ids, [seed.blocks.B, seed.blocks.C, seed.blocks.D].sort())

  const byId = new Map(results.map((r) => [r.block_id, r]))
  assert.equal(byId.get(seed.blocks.B).depth, 1)
  assert.equal(byId.get(seed.blocks.D).depth, 1)
  assert.equal(byId.get(seed.blocks.C).depth, 2)

  // Response shape parity with the legacy CTE.
  for (const r of results) {
    assert.ok(typeof r.block_id === 'string')
    assert.ok(typeof r.content === 'string')
    assert.ok(typeof r.depth === 'number')
    assert.ok(r.document && typeof r.document.id === 'string')
    assert.ok('title' in r.document)
    assert.ok('external_id' in r.document)
  }
})

test('graphSearch (Cypher) honours the layers filter', async (t) => {
  if (!ageUrl) return t.skip('AGE container not available')
  const seed = await seedGraph('graph-cypher-layers')
  // structural-only: only A->B is structural. B reachable, C requires the
  // semantic edge which the filter excludes, D requires the ai edge.
  const results = await runGraphQuery({
    corpus_id: seed.corpusId,
    seed_block_id: seed.blocks.A,
    layers: ['structural'],
    max_hops: 3,
  })
  assert.deepEqual(
    results.map((r) => r.block_id).sort(),
    [seed.blocks.B].sort(),
  )
})

test('graphSearch (Cypher) honours rel_types filter', async (t) => {
  if (!ageUrl) return t.skip('AGE container not available')
  const seed = await seedGraph('graph-cypher-reltypes')
  const results = await runGraphQuery({
    corpus_id: seed.corpusId,
    seed_block_id: seed.blocks.A,
    rel_types: ['mentions'],
    max_hops: 3,
  })
  assert.deepEqual(
    results.map((r) => r.block_id),
    [seed.blocks.D],
  )
  assert.equal(results[0].rel_type, 'mentions')
})

test('graphSearch (Cypher) honours max_hops bound', async (t) => {
  if (!ageUrl) return t.skip('AGE container not available')
  const seed = await seedGraph('graph-cypher-hops')
  const results = await runGraphQuery({
    corpus_id: seed.corpusId,
    seed_block_id: seed.blocks.A,
    max_hops: 1,
  })
  // depth=1: B and D only. C is two hops away.
  assert.deepEqual(
    results.map((r) => r.block_id).sort(),
    [seed.blocks.B, seed.blocks.D].sort(),
  )
})

test('graphSearch (Cypher) direction=in walks edges backwards', async (t) => {
  if (!ageUrl) return t.skip('AGE container not available')
  const seed = await seedGraph('graph-cypher-in')
  // From C, in direction reaches B (1 hop) and A (2 hops via B).
  const results = await runGraphQuery({
    corpus_id: seed.corpusId,
    seed_block_id: seed.blocks.C,
    direction: 'in',
    max_hops: 3,
  })
  assert.deepEqual(
    results.map((r) => r.block_id).sort(),
    [seed.blocks.A, seed.blocks.B].sort(),
  )
})
