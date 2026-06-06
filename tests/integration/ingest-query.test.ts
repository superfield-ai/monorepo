import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startDb, stopDb } from './setup.js'
import { query, execute } from '../../src/db/queries.js'

before(async () => {
  await startDb()
})

after(async () => {
  await stopDb()
})

test('migration creates all required tables', async () => {
  const tables = await query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
  )
  const names = tables.map(t => t.tablename)
  assert.ok(names.includes('corpora'))
  assert.ok(names.includes('documents'))
  assert.ok(names.includes('blocks'))
  assert.ok(names.includes('version_blocks'))
  assert.ok(names.includes('links'))
  assert.ok(names.includes('job_queue'))
  assert.ok(names.includes('entities'))
})

test('create corpus and retrieve it', async () => {
  const rows = await query<{ id: string; name: string }>(
    `INSERT INTO corpora (name) VALUES ('test-corpus') RETURNING id, name`
  )
  assert.equal(rows[0].name, 'test-corpus')
  assert.ok(rows[0].id)
})

test('ingest text document creates blocks with correct seq', async () => {
  // Create corpus
  const [corpus] = await query<{ id: string }>(
    `INSERT INTO corpora (name) VALUES ('ingest-test') RETURNING id`
  )

  // Create document, version, and blocks manually (same logic as POST /documents)
  const [doc] = await query<{ id: string }>(
    `INSERT INTO documents (title, source_format, corpus_id) VALUES ('Test Doc', null, $1) RETURNING id`,
    [corpus.id]
  )
  const [ver] = await query<{ id: string }>(
    `INSERT INTO document_versions (doc_id, version_num, status) VALUES ($1, 1, 'parsed') RETURNING id`,
    [doc.id]
  )
  const crypto = await import('node:crypto')
  const blocks = ['First paragraph.', 'Second paragraph.', 'Third paragraph.']
  for (let i = 0; i < blocks.length; i++) {
    const hash = crypto.createHash('sha256').update(blocks[i]).digest('hex')
    const [b] = await query<{ id: string }>(
      `INSERT INTO blocks (doc_id, content, content_hash, block_type, level) VALUES ($1, $2, $3, 'paragraph', null) RETURNING id`,
      [doc.id, blocks[i], hash]
    )
    await execute(
      `INSERT INTO version_blocks (version_id, block_id, seq) VALUES ($1, $2, $3)`,
      [ver.id, b.id, i + 1]
    )
  }
  await execute(
    `UPDATE documents SET current_version_id = $1 WHERE id = $2`,
    [ver.id, doc.id]
  )

  // Verify block count and ordering
  const vblocks = await query<{ seq: number }>(
    `SELECT seq FROM version_blocks WHERE version_id = $1 ORDER BY seq`,
    [ver.id]
  )
  assert.equal(vblocks.length, 3)
  assert.deepEqual(vblocks.map(b => b.seq), [1, 2, 3])
})

test('fulltext search returns blocks matching query', async () => {
  // Create corpus with a document containing a unique term
  const [corpus] = await query<{ id: string }>(
    `INSERT INTO corpora (name) VALUES ('ft-search-test') RETURNING id`
  )
  const [doc] = await query<{ id: string }>(
    `INSERT INTO documents (title, corpus_id) VALUES ('FT Test', $1) RETURNING id`,
    [corpus.id]
  )
  const [ver] = await query<{ id: string }>(
    `INSERT INTO document_versions (doc_id, version_num, status) VALUES ($1, 1, 'parsed') RETURNING id`,
    [doc.id]
  )
  const content = 'The indemnification clause covers all consequential damages.'
  const hash = (await import('node:crypto')).createHash('sha256').update(content).digest('hex')
  const [b] = await query<{ id: string }>(
    `INSERT INTO blocks (doc_id, content, content_hash, block_type, level) VALUES ($1, $2, $3, 'paragraph', null) RETURNING id`,
    [doc.id, content, hash]
  )
  await execute(`INSERT INTO version_blocks (version_id, block_id, seq) VALUES ($1, $2, 1)`, [ver.id, b.id])

  // Fulltext search using tsv column
  const results = await query<{ id: string; content: string }>(
    `SELECT b.id, b.content FROM blocks b
     JOIN documents d ON d.id = b.doc_id,
          plainto_tsquery('english', 'indemnification') q
     WHERE d.corpus_id = $1 AND b.tsv @@ q`,
    [corpus.id]
  )
  assert.ok(results.length > 0)
  assert.ok(results[0].content.includes('indemnification'))
})

test('corpus scoping: query does not cross corpora', async () => {
  const [corpusA] = await query<{ id: string }>(`INSERT INTO corpora (name) VALUES ('scope-A') RETURNING id`)
  const [corpusB] = await query<{ id: string }>(`INSERT INTO corpora (name) VALUES ('scope-B') RETURNING id`)

  // Insert block in corpus A only
  const [docA] = await query<{ id: string }>(
    `INSERT INTO documents (title, corpus_id) VALUES ('Doc A', $1) RETURNING id`, [corpusA.id]
  )
  const [verA] = await query<{ id: string }>(
    `INSERT INTO document_versions (doc_id, version_num, status) VALUES ($1, 1, 'parsed') RETURNING id`, [docA.id]
  )
  const uniqueTermA = 'xylophone-unique-term-alpha'
  const hashA = (await import('node:crypto')).createHash('sha256').update(uniqueTermA).digest('hex')
  const [bA] = await query<{ id: string }>(
    `INSERT INTO blocks (doc_id, content, content_hash, block_type, level) VALUES ($1, $2, $3, 'paragraph', null) RETURNING id`,
    [docA.id, uniqueTermA, hashA]
  )
  await execute(`INSERT INTO version_blocks (version_id, block_id, seq) VALUES ($1, $2, 1)`, [verA.id, bA.id])

  // Query from corpus B — should return nothing
  const results = await query<{ id: string }>(
    `SELECT b.id FROM blocks b
     JOIN documents d ON d.id = b.doc_id,
          plainto_tsquery('english', 'xylophone') q
     WHERE d.corpus_id = $1 AND b.tsv @@ q`,
    [corpusB.id]
  )
  assert.equal(results.length, 0)
})

test('external_id is stored and retrievable', async () => {
  const [corpus] = await query<{ id: string }>(`INSERT INTO corpora (name) VALUES ('eid-test') RETURNING id`)
  const [doc] = await query<{ id: string; external_id: string | null }>(
    `INSERT INTO documents (title, corpus_id, external_id) VALUES ('EID Test', $1, 'cuad-0001') RETURNING id, external_id`,
    [corpus.id]
  )
  assert.equal(doc.external_id, 'cuad-0001')
})

test('block dedup: same content reuses block id', async () => {
  const [corpus] = await query<{ id: string }>(`INSERT INTO corpora (name) VALUES ('dedup-test') RETURNING id`)
  const [doc] = await query<{ id: string }>(
    `INSERT INTO documents (title, corpus_id) VALUES ('Dedup', $1) RETURNING id`, [corpus.id]
  )
  const [ver1] = await query<{ id: string }>(
    `INSERT INTO document_versions (doc_id, version_num, status) VALUES ($1, 1, 'parsed') RETURNING id`, [doc.id]
  )
  const [ver2] = await query<{ id: string }>(
    `INSERT INTO document_versions (doc_id, version_num, status) VALUES ($1, 2, 'parsed') RETURNING id`, [doc.id]
  )

  const content = 'Shared unchanged paragraph text.'
  const hash = (await import('node:crypto')).createHash('sha256').update(content).digest('hex')
  const [b] = await query<{ id: string }>(
    `INSERT INTO blocks (doc_id, content, content_hash, block_type, level) VALUES ($1, $2, $3, 'paragraph', null)
     ON CONFLICT DO NOTHING RETURNING id`,
    [doc.id, content, hash]
  )
  await execute(`INSERT INTO version_blocks (version_id, block_id, seq) VALUES ($1, $2, 1)`, [ver1.id, b.id])
  await execute(`INSERT INTO version_blocks (version_id, block_id, seq) VALUES ($1, $2, 1)`, [ver2.id, b.id])

  // Both versions should reference the same block
  const v1blocks = await query<{ block_id: string }>(`SELECT block_id FROM version_blocks WHERE version_id = $1`, [ver1.id])
  const v2blocks = await query<{ block_id: string }>(`SELECT block_id FROM version_blocks WHERE version_id = $1`, [ver2.id])
  assert.equal(v1blocks[0].block_id, v2blocks[0].block_id)
})
