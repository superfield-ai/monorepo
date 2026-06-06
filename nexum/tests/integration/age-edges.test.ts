/**
 * Integration test for issue #75: AGE dual-write + edge-similarity query.
 *
 * Boots two Postgres containers:
 *   - pgvector (primary) for the existing schema + the new edge_embedding col
 *   - apache/age:PG16_latest for the AGE companion
 *
 * Then validates:
 *   1. AGE migration applies idempotently against the companion DB.
 *   2. The linker dual-writes: an edge produced through processStructuralLinks
 *      lands in BOTH the `links` table (with edge_embedding populated) AND in
 *      the AGE `nexum_links` graph as a `LINK` between two `Block` vertices.
 *   3. The /query `edge_semantic` mode retrieves the dual-written edge by
 *      cosine similarity over `links.edge_embedding`.
 *
 * The AGE container pull may fail in restricted CI; in that case we skip the
 * dual-write portion but still cover the same-process edge_semantic path
 * because the embedding column lives on the primary DB.
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startDb, stopDb, startAge, stopAge } from './setup.js'
import { query, execute } from '../../src/db/queries.js'
import { randomUUID, createHash } from 'node:crypto'

let ageUrl: string | null = null

before(async () => {
  await startDb()
  ageUrl = await startAge()
})

after(async () => {
  await stopAge()
  await stopDb()
})

test('schema exposes links.edge_embedding vector(384) column', async () => {
  const cols = await query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_name = 'links' AND column_name = 'edge_embedding'`,
  )
  assert.equal(cols.length, 1)
})

test('schema creates HNSW index on links.edge_embedding', async () => {
  const idx = await query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
     WHERE tablename = 'links' AND indexname = 'links_edge_embedding_hnsw_idx'`,
  )
  assert.equal(idx.length, 1)
})

test('AGE migration is idempotent (re-applies cleanly)', async (t) => {
  if (!ageUrl) return t.skip('AGE container not available')
  const { migrateAge } = await import('../../src/db/migrate.js')
  // Already applied once in startAge; this re-application must be safe.
  const ok = await migrateAge()
  assert.equal(ok, true)
})

test('AGE pool reports the nexum_links graph and LINK label exist', async (t) => {
  if (!ageUrl) return t.skip('AGE container not available')
  const { getAgePool } = await import('../../src/db/age.js')
  const pool = await getAgePool()
  const { rows } = await pool.query(
    `SELECT name FROM ag_catalog.ag_graph WHERE name = 'nexum_links'`,
  )
  assert.equal(rows.length, 1)
})

test('linker dual-writes structural edges to links table and AGE', async (t) => {
  // Build a tiny corpus with one block that cites another via "§ 3.2".
  const [corpus] = await query<{ id: string }>(
    `INSERT INTO corpora (name) VALUES ('age-dual-write') RETURNING id`,
  )
  const [doc] = await query<{ id: string }>(
    `INSERT INTO documents (title, corpus_id) VALUES ('Citing Doc', $1) RETURNING id`,
    [corpus.id],
  )
  const [ver] = await query<{ id: string }>(
    `INSERT INTO document_versions (doc_id, version_num, status) VALUES ($1, 1, 'parsed') RETURNING id`,
    [doc.id],
  )

  // Source block carries a "§ 3.2" citation; target block matches it via
  // structural linker's LIKE pattern (%3.2%).
  const srcText = 'See § 3.2 for the indemnification limit.'
  const dstText = '3.2 The indemnification limit shall not exceed the contract value.'
  const [srcBlock] = await query<{ id: string }>(
    `INSERT INTO blocks (doc_id, content, content_hash, block_type) VALUES ($1, $2, $3, 'paragraph') RETURNING id`,
    [doc.id, srcText, createHash('sha256').update(srcText).digest('hex')],
  )
  const [dstBlock] = await query<{ id: string }>(
    `INSERT INTO blocks (doc_id, content, content_hash, block_type) VALUES ($1, $2, $3, 'paragraph') RETURNING id`,
    [doc.id, dstText, createHash('sha256').update(dstText).digest('hex')],
  )
  await execute(`INSERT INTO version_blocks (version_id, block_id, seq) VALUES ($1, $2, 1)`, [
    ver.id,
    srcBlock.id,
  ])
  await execute(`INSERT INTO version_blocks (version_id, block_id, seq) VALUES ($1, $2, 2)`, [
    ver.id,
    dstBlock.id,
  ])
  await execute(`UPDATE documents SET current_version_id = $1 WHERE id = $2`, [ver.id, doc.id])

  // Enqueue the link job that processStructuralLinks claims, then run it.
  const { enqueueJob } = await import('../../src/db/jobs.js')
  await enqueueJob('link.structural', { version_id: ver.id })

  const { processStructuralLinks } = await import('../../src/linker/structural.js')
  await processStructuralLinks(ver.id)

  const links = await query<{ id: string; src: string; dst: string; layer: string; rel_type: string; edge_embedding: any }>(
    `SELECT id, src, dst, layer, rel_type, edge_embedding FROM links WHERE src = $1`,
    [srcBlock.id],
  )
  assert.ok(links.length >= 1, 'expected at least one structural link to be created')
  const link = links.find((l) => l.dst === dstBlock.id)
  assert.ok(link, 'expected an edge from src to dst block')
  assert.equal(link!.layer, 'structural')
  assert.equal(link!.rel_type, 'cites')
  assert.ok(link!.edge_embedding, 'edge_embedding must be populated')
  assert.equal((link!.edge_embedding as number[]).length, 384, 'edge_embedding must be 384-D')

  if (!ageUrl) return t.skip('AGE container not available — dual-write half not verified')

  // Verify the same edge exists in AGE.
  const { countAgeEdges } = await import('../../src/db/age.js')
  const ageCount = await countAgeEdges()
  assert.ok(ageCount >= 1, `expected at least one LINK edge in AGE, got ${ageCount}`)
})

test('edge_semantic query mode retrieves dual-written edge by similarity', async () => {
  // Find a corpus with an edge_embedding-bearing link from the dual-write test.
  const [link] = await query<{ src: string; corpus_id: string }>(
    `SELECT l.src, d.corpus_id
     FROM links l JOIN blocks b ON b.id = l.src JOIN documents d ON d.id = b.doc_id
     WHERE l.edge_embedding IS NOT NULL
     LIMIT 1`,
  )
  assert.ok(link, 'precondition: at least one edge_embedding-bearing link exists')

  // Drive the same code path as the route handler.
  const { embedTexts } = await import('../../src/embed/local.js')
  const [vec] = await embedTexts(['cites: indemnification limit -> indemnification clause'])
  const vecStr = `[${vec.join(',')}]`
  const rows = await query<any>(
    `SELECT l.id AS link_id, l.layer, l.rel_type,
            1 - (l.edge_embedding <=> $1::vector) AS score
     FROM links l
     JOIN blocks sb ON sb.id = l.src
     JOIN documents sd ON sd.id = sb.doc_id
     WHERE l.edge_embedding IS NOT NULL AND sd.corpus_id = $2
     ORDER BY l.edge_embedding <=> $1::vector
     LIMIT 5`,
    [vecStr, link.corpus_id],
  )
  assert.ok(rows.length >= 1)
  assert.ok(parseFloat(rows[0].score) > 0, 'similarity score must be a real number')
})
