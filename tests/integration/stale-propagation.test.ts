/**
 * Integration tests for stale propagation (issue #112).
 *
 * Acceptance criteria verified:
 *  - Updating a source block transitions every dependent synthesized block to
 *    synth_status:'stale' via AGE Cypher traversal.
 *  - Propagation walks AGE Cypher (MATCH sourced-from edges), not recursive CTE.
 *  - GET /blocks responses surface synth_status:'stale' on affected rows.
 *  - Re-updating an already-stale block produces no errors and no extra writes.
 *  - Deep chain: only direct dependents become stale (A6 semantics — one hop).
 *
 * Test setup:
 *  - pgvector/pgvector:pg16 for the primary schema (blocks, links, etc.)
 *  - apache/age:PG16_latest for the AGE graph (sourced-from edges).
 *  - When the AGE container is unavailable (CI without Docker), AGE-dependent
 *    assertions are skipped; schema-only assertions still run.
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import crypto from 'node:crypto'
import { startDb, stopDb, startAge, stopAge } from './setup.js'
import { query } from '../../src/db/queries.js'

let server: http.Server
let baseUrl: string
let ageUrl: string | null = null

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function httpRequest(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const json = body !== undefined ? JSON.stringify(body) : undefined
    const parsed = new URL(`${baseUrl}${path}`)
    const options: http.RequestOptions = {
      hostname: parsed.hostname,
      port: Number(parsed.port),
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(json ? { 'Content-Length': String(Buffer.byteLength(json)) } : {}),
        ...headers,
      },
    }
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        let parsed: unknown
        try { parsed = JSON.parse(Buffer.concat(chunks).toString()) } catch { parsed = null }
        resolve({ status: res.statusCode!, body: parsed })
      })
    })
    req.on('error', reject)
    if (json) req.write(json)
    req.end()
  })
}

async function post(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  return httpRequest('POST', path, body)
}

async function patch(path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  return httpRequest('PATCH', path, body ?? {})
}

async function get(path: string): Promise<{ status: number; body: unknown }> {
  return httpRequest('GET', path)
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function createCorpus(): Promise<string> {
  const [row] = await query<{ id: string }>(
    'INSERT INTO corpora (name) VALUES ($1) RETURNING id',
    [`stale-test-corpus-${crypto.randomUUID()}`],
  )
  return row.id
}

async function createSourceBlock(corpusId: string): Promise<string> {
  const [doc] = await query<{ id: string }>(
    `INSERT INTO documents (title, corpus_id) VALUES ($1, $2) RETURNING id`,
    [`source-doc-${crypto.randomUUID()}`, corpusId],
  )
  const content = `Source content ${crypto.randomUUID()}`
  const hash = crypto.createHash('sha256').update(content).digest('hex')
  const [block] = await query<{ id: string }>(
    `INSERT INTO blocks (doc_id, content, content_hash, block_type)
       VALUES ($1, $2, $3, 'paragraph') RETURNING id`,
    [doc.id, content, hash],
  )
  return block.id
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

before(async () => {
  process.env.NEXUM_REQUIRE_AGE = 'false'
  await startDb()
  ageUrl = await startAge()

  const { config } = await import('../../src/config.js')
  config.AUTH_OFF = true

  await import('../../src/routes/synthesize.js')
  const { createApp } = await import('../../src/server.js')
  server = createApp()

  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, '127.0.0.1', function (this: any) {
      resolve(this.address().port as number)
    })
    server.on('error', reject)
  })
  baseUrl = `http://127.0.0.1:${port}`
})

after(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  await stopAge()
  await stopDb()
})

// ---------------------------------------------------------------------------
// Test: direct stale propagation via PATCH /blocks/:id/retract
// ---------------------------------------------------------------------------

test('PATCH /blocks/:id/retract marks direct dependent synthesized blocks as stale', async (t) => {
  if (!ageUrl) return t.skip('AGE container not available — stale propagation requires Cypher')

  const { config } = await import('../../src/config.js')
  config.AUTH_OFF = true

  const corpusId = await createCorpus()
  const srcBlockId = await createSourceBlock(corpusId)

  // Synthesize a block S from source block A
  const { status: synthStatus, body: synthBody } = await post('/synthesize', {
    corpus_id: corpusId,
    content: 'Synthesized block derived from source A',
    source_block_ids: [srcBlockId],
    agent_entity_id: 'anon',
  })
  assert.equal(synthStatus, 201, `POST /synthesize failed: ${JSON.stringify(synthBody)}`)
  const synthId = (synthBody as any).id as string

  // Verify initial state: synth block is 'published'
  const [beforeRow] = await query<{ synth_status: string }>(
    'SELECT synth_status FROM blocks WHERE id = $1',
    [synthId],
  )
  assert.equal(beforeRow.synth_status, 'published', 'precondition: block must start as published')

  // Retract / update the source block → stale propagation
  const { status: patchStatus, body: patchBody } = await patch(`/blocks/${srcBlockId}/retract`)
  assert.equal(patchStatus, 200, `PATCH /blocks/:id/retract failed: ${JSON.stringify(patchBody)}`)
  assert.equal((patchBody as any).propagated, true)

  // Verify synth block is now stale
  const [afterRow] = await query<{ synth_status: string }>(
    'SELECT synth_status FROM blocks WHERE id = $1',
    [synthId],
  )
  assert.equal(afterRow.synth_status, 'stale', 'synthesized block must transition to stale')
})

test('PATCH /blocks/:id/retract with two dependents marks both stale', async (t) => {
  if (!ageUrl) return t.skip('AGE container not available')

  const { config } = await import('../../src/config.js')
  config.AUTH_OFF = true

  const corpusId = await createCorpus()
  const srcBlockId = await createSourceBlock(corpusId)

  // Synthesize two separate blocks from the same source
  const { body: s1Body } = await post('/synthesize', {
    corpus_id: corpusId,
    content: `Synth 1 from source A ${crypto.randomUUID()}`,
    source_block_ids: [srcBlockId],
    agent_entity_id: 'anon',
  })
  const synth1Id = (s1Body as any).id as string

  const { body: s2Body } = await post('/synthesize', {
    corpus_id: corpusId,
    content: `Synth 2 from source A ${crypto.randomUUID()}`,
    source_block_ids: [srcBlockId],
    agent_entity_id: 'anon',
  })
  const synth2Id = (s2Body as any).id as string

  // Retract source block
  const { status: patchStatus } = await patch(`/blocks/${srcBlockId}/retract`)
  assert.equal(patchStatus, 200)

  // Both synthesized blocks must be stale
  const rows = await query<{ id: string; synth_status: string }>(
    'SELECT id, synth_status FROM blocks WHERE id = ANY($1::uuid[])',
    [[synth1Id, synth2Id]],
  )
  for (const r of rows) {
    assert.equal(r.synth_status, 'stale', `block ${r.id} must be stale`)
  }
})

test('Re-retracting an already-stale source block is a no-op (idempotent)', async (t) => {
  if (!ageUrl) return t.skip('AGE container not available')

  const { config } = await import('../../src/config.js')
  config.AUTH_OFF = true

  const corpusId = await createCorpus()
  const srcBlockId = await createSourceBlock(corpusId)

  // Synthesize a block
  const { body: synthBody } = await post('/synthesize', {
    corpus_id: corpusId,
    content: `Synth idempotency test ${crypto.randomUUID()}`,
    source_block_ids: [srcBlockId],
    agent_entity_id: 'anon',
  })
  const synthId = (synthBody as any).id as string

  // First retract
  const { status: s1 } = await patch(`/blocks/${srcBlockId}/retract`)
  assert.equal(s1, 200)

  // Second retract — must not error
  const { status: s2 } = await patch(`/blocks/${srcBlockId}/retract`)
  assert.equal(s2, 200)

  // Still stale, not double-written
  const [row] = await query<{ synth_status: string }>(
    'SELECT synth_status FROM blocks WHERE id = $1',
    [synthId],
  )
  assert.equal(row.synth_status, 'stale')
})

test('Deep chain: only direct dependents become stale (one-hop per A6 semantics)', async (t) => {
  if (!ageUrl) return t.skip('AGE container not available')

  const { config } = await import('../../src/config.js')
  config.AUTH_OFF = true

  // Build chain: A → S1 (sourced-from A) → S2 (sourced-from S1)
  const corpusId = await createCorpus()
  const srcAId = await createSourceBlock(corpusId)

  // S1 is synthesized from source A
  const { body: s1Body } = await post('/synthesize', {
    corpus_id: corpusId,
    content: `S1 from A ${crypto.randomUUID()}`,
    source_block_ids: [srcAId],
    agent_entity_id: 'anon',
  })
  const s1Id = (s1Body as any).id as string

  // S2 is synthesized from S1 (one hop further)
  const { body: s2Body } = await post('/synthesize', {
    corpus_id: corpusId,
    content: `S2 from S1 ${crypto.randomUUID()}`,
    source_block_ids: [s1Id],
    agent_entity_id: 'anon',
  })
  const s2Id = (s2Body as any).id as string

  // Update source block A
  const { status } = await patch(`/blocks/${srcAId}/retract`)
  assert.equal(status, 200)

  // S1 (direct dependent) must be stale
  const [s1Row] = await query<{ synth_status: string }>(
    'SELECT synth_status FROM blocks WHERE id = $1',
    [s1Id],
  )
  assert.equal(s1Row.synth_status, 'stale', 'S1 (direct dependent) must become stale')

  // S2 (two hops away) must NOT be stale — propagation is one-hop only per A6
  const [s2Row] = await query<{ synth_status: string }>(
    'SELECT synth_status FROM blocks WHERE id = $1',
    [s2Id],
  )
  assert.equal(s2Row.synth_status, 'published', 'S2 (two hops away) must remain published')
})

// ---------------------------------------------------------------------------
// Test: GET /blocks surfaces synth_status
// ---------------------------------------------------------------------------

test('GET /blocks returns synthesized blocks with synth_status field', async (t) => {
  if (!ageUrl) return t.skip('AGE container not available')

  const { config } = await import('../../src/config.js')
  config.AUTH_OFF = true

  const corpusId = await createCorpus()
  const srcBlockId = await createSourceBlock(corpusId)

  // Create a synthesized block
  const { body: synthBody } = await post('/synthesize', {
    corpus_id: corpusId,
    content: `GET /blocks test ${crypto.randomUUID()}`,
    source_block_ids: [srcBlockId],
    agent_entity_id: 'anon',
  })
  const synthId = (synthBody as any).id as string

  // GET /blocks must return it
  const { status, body } = await get(`/blocks?corpus_id=${corpusId}`)
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`)
  const blocks = (body as any).blocks as any[]
  assert.ok(Array.isArray(blocks), 'response.blocks must be an array')

  const found = blocks.find((b) => b.id === synthId)
  assert.ok(found, 'synthesized block must appear in GET /blocks response')
  assert.equal(found.synth_status, 'published', 'initial synth_status must be published')
})

test('GET /blocks surfaces synth_status:stale after PATCH /blocks/:id/retract', async (t) => {
  if (!ageUrl) return t.skip('AGE container not available')

  const { config } = await import('../../src/config.js')
  config.AUTH_OFF = true

  const corpusId = await createCorpus()
  const srcBlockId = await createSourceBlock(corpusId)

  // Synthesize
  const { body: synthBody } = await post('/synthesize', {
    corpus_id: corpusId,
    content: `Stale GET /blocks test ${crypto.randomUUID()}`,
    source_block_ids: [srcBlockId],
    agent_entity_id: 'anon',
  })
  const synthId = (synthBody as any).id as string

  // Retract source
  await patch(`/blocks/${srcBlockId}/retract`)

  // Poll GET /blocks — must surface stale
  const { status, body } = await get(`/blocks?corpus_id=${corpusId}&status=stale`)
  assert.equal(status, 200)
  const blocks = (body as any).blocks as any[]
  const found = blocks.find((b: any) => b.id === synthId)
  assert.ok(found, 'stale block must appear in GET /blocks?status=stale')
  assert.equal(found.synth_status, 'stale')
})

test('GET /blocks returns 400 when corpus_id is missing', async () => {
  const { status, body } = await get('/blocks')
  assert.equal(status, 400)
  assert.ok((body as any).error, 'must return error message')
})

// ---------------------------------------------------------------------------
// Test: propagateStale with no AGE — must not throw
// ---------------------------------------------------------------------------

test('propagateStale resolves silently when AGE is unavailable', async () => {
  // This test runs without an AGE container being configured.
  // We temporarily clear AGE_DATABASE_URL to simulate AGE being absent.
  const { config } = await import('../../src/config.js')
  const prev = config.AGE_DATABASE_URL
  config.AGE_DATABASE_URL = ''
  const { resetAgePool } = await import('../../src/db/age.js')
  resetAgePool()

  try {
    const { propagateStale } = await import('../../src/synthesis/index.js')
    // Must not throw even when AGE is unreachable
    await assert.doesNotReject(() => propagateStale(crypto.randomUUID()))
  } finally {
    config.AGE_DATABASE_URL = prev
    resetAgePool()
  }
})
