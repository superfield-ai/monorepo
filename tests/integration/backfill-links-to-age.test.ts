/**
 * Integration test for issue #100 — backfillLinksToAge() must copy every row
 * of the primary `links` table into the `nexum_links` AGE graph as part of
 * the standard `migrate()` entry point, and re-running migrate against an
 * already-backfilled database must be a no-op.
 *
 * The test relies on the same Apache AGE testcontainer used by
 * tests/integration/age-edges.test.ts. When the AGE image is not pullable
 * (e.g. restricted CI), the AGE-dependent assertions are skipped — the
 * dev-scout AGE-unavailable contract is already covered by the unit tests in
 * tests/unit/backfill-links-validation.test.mjs.
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { startDb, stopDb, startAge, stopAge } from './setup.js'
import { query, execute } from '../../src/db/queries.js'

let ageUrl: string | null = null

before(async () => {
  await startDb()
  ageUrl = await startAge()
})

after(async () => {
  await stopAge()
  await stopDb()
})

async function seedLink(corpusName: string): Promise<{ linkId: string }> {
  const [corpus] = await query<{ id: string }>(
    `INSERT INTO corpora (name) VALUES ($1) RETURNING id`,
    [corpusName],
  )
  const [doc] = await query<{ id: string }>(
    `INSERT INTO documents (title, corpus_id) VALUES ('Backfill Doc', $1) RETURNING id`,
    [corpus.id],
  )
  const [ver] = await query<{ id: string }>(
    `INSERT INTO document_versions (doc_id, version_num, status) VALUES ($1, 1, 'parsed') RETURNING id`,
    [doc.id],
  )
  const srcText = `src ${randomUUID()}`
  const dstText = `dst ${randomUUID()}`
  const [src] = await query<{ id: string }>(
    `INSERT INTO blocks (doc_id, content, content_hash, block_type) VALUES ($1, $2, $3, 'paragraph') RETURNING id`,
    [doc.id, srcText, createHash('sha256').update(srcText).digest('hex')],
  )
  const [dst] = await query<{ id: string }>(
    `INSERT INTO blocks (doc_id, content, content_hash, block_type) VALUES ($1, $2, $3, 'paragraph') RETURNING id`,
    [doc.id, dstText, createHash('sha256').update(dstText).digest('hex')],
  )
  await execute(
    `INSERT INTO version_blocks (version_id, block_id, seq) VALUES ($1, $2, 1), ($1, $3, 2)`,
    [ver.id, src.id, dst.id],
  )
  await execute(`UPDATE documents SET current_version_id = $1 WHERE id = $2`, [ver.id, doc.id])
  const [link] = await query<{ id: string }>(
    `INSERT INTO links (src, dst, layer, rel_type, weight, provenance)
     VALUES ($1, $2, 'structural', 'cites', 1.0, '{"model":"backfill-test"}'::jsonb)
     RETURNING id`,
    [src.id, dst.id],
  )
  return { linkId: link.id }
}

test('backfillLinksToAge copies every links row into AGE as a LINK edge', async (t) => {
  if (!ageUrl) return t.skip('AGE container not available')

  // Wipe AGE and links so this test owns the count assertion.
  const { getAgePool, resetAgePool } = await import('../../src/db/age.js')
  resetAgePool()
  const agePool = await getAgePool()
  assert.ok(agePool, 'AGE pool must be available for this test')
  await agePool!.query(`SELECT * FROM cypher('nexum_links', $$ MATCH (n) DETACH DELETE n $$) AS (v agtype)`)
  await execute(`DELETE FROM links`)

  const N = 7
  for (let i = 0; i < N; i++) await seedLink(`backfill-fresh-${i}`)

  const { backfillLinksToAge } = await import('../../src/db/migrate.js')
  const result = await backfillLinksToAge()
  assert.equal(result.ok, true)
  assert.equal(result.copied, N)
  assert.equal(result.total, N)

  const { countAgeEdges } = await import('../../src/db/age.js')
  const edges = await countAgeEdges()
  assert.equal(edges, N, 'AGE LINK edge count must equal links row count after backfill')
})

test('re-running backfillLinksToAge against a backfilled graph copies zero rows', async (t) => {
  if (!ageUrl) return t.skip('AGE container not available')

  const { backfillLinksToAge } = await import('../../src/db/migrate.js')
  const { countAgeEdges } = await import('../../src/db/age.js')

  const before = await countAgeEdges()
  const result = await backfillLinksToAge()
  const after = await countAgeEdges()

  assert.equal(result.ok, true)
  assert.equal(result.copied, 0, 'no rows should be copied on a no-op re-run')
  assert.equal(result.skipped, 'already-backfilled')
  assert.equal(after, before, 'edge count must be stable across re-runs')
})

test('backfillLinksToAge runs as part of migrate() and produces matching counts', async (t) => {
  if (!ageUrl) return t.skip('AGE container not available')

  // Add one more link row beyond the previously backfilled set, then run the
  // full migrate() entry point. The backfill gate ("AGE edges < links rows")
  // should fire and heal the new row.
  const before = await query<{ n: string }>(`SELECT count(*)::text AS n FROM links`)
  const beforeRows = parseInt(before[0].n, 10)
  await seedLink(`backfill-via-migrate-${randomUUID()}`)

  const { migrate } = await import('../../src/db/migrate.js')
  await migrate()

  const { countAgeEdges } = await import('../../src/db/age.js')
  const after = await query<{ n: string }>(`SELECT count(*)::text AS n FROM links`)
  const afterRows = parseInt(after[0].n, 10)
  const ageEdges = await countAgeEdges()

  assert.equal(afterRows, beforeRows + 1)
  assert.equal(ageEdges, afterRows, 'migrate() must leave AGE edge count == links row count')
})
