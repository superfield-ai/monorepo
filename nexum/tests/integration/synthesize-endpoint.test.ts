/**
 * Integration tests for POST /synthesize (issue #110).
 *
 * Acceptance criteria:
 *  - POST /synthesize creates a block with origin:'synthesized' and synth_status:'published'
 *  - 'sourced-from' relational links are created for each source_block_id
 *  - Request rejected (403) when principal != agent_entity_id
 *  - Request rejected (403) when principal lacks blocks:synthesize scope
 *  - Malformed source_block_ids cause the entire transaction to roll back
 *
 * Test setup: pgvector/pgvector:pg16 via testcontainers.
 *
 * Auth strategy:
 *  - Happy-path and validation tests use NEXUM_AUTH=off (config.AUTH_OFF=true)
 *    so the anon principal (id='anon', scopes=['*']) is returned without a token.
 *  - 403 tests temporarily enable auth, create a real entity, and send a Bearer
 *    token, then restore AUTH_OFF for subsequent tests.
 *
 * AGE is not available in CI (no apache/age container). writeAgeEdge is
 * best-effort and fails silently. Only the Postgres state is verified.
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import crypto from 'node:crypto'
import { startDb, stopDb } from './setup.js'
import { query } from '../../src/db/queries.js'

let server: http.Server
let baseUrl: string

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(body)
    const parsed = new URL(`${baseUrl}${path}`)
    const options: http.RequestOptions = {
      hostname: parsed.hostname,
      port: Number(parsed.port),
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(json),
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
    req.write(json)
    req.end()
  })
}

/** Insert a minimal corpus and return its id. */
async function createCorpus(name = `test-corpus-${crypto.randomUUID()}`): Promise<string> {
  const [row] = await query<{ id: string }>(
    'INSERT INTO corpora (name) VALUES ($1) RETURNING id',
    [name],
  )
  return row.id
}

/** Insert a source block and return its id. */
async function createSourceBlock(corpusId: string): Promise<string> {
  const [doc] = await query<{ id: string }>(
    `INSERT INTO documents (title, corpus_id) VALUES ($1, $2) RETURNING id`,
    [`source-doc-${crypto.randomUUID()}`, corpusId],
  )
  const content = `Source content ${crypto.randomUUID()}`
  const hash = crypto.createHash('sha256').update(content).digest('hex')
  const [block] = await query<{ id: string }>(
    `INSERT INTO blocks (doc_id, content, content_hash, block_type) VALUES ($1, $2, $3, 'paragraph') RETURNING id`,
    [doc.id, content, hash],
  )
  return block.id
}

/**
 * Create an entity with given scopes. Scopes are stored as a Postgres text[]
 * so they must be passed as a proper array parameter (not JSON.stringify).
 */
async function createEntity(scopes: string[]): Promise<{ id: string; apiKey: string }> {
  const key = `nxm_${crypto.randomBytes(32).toString('hex')}`
  const hash = crypto.createHash('sha256').update(key).digest('hex')
  const id = crypto.randomUUID()
  // Pass scopes directly as an array — pg driver marshals JS arrays to PG arrays.
  await query(
    `INSERT INTO entities (id, type, name, api_key_hash, scopes) VALUES ($1, 'agent', $2, $3, $4)`,
    [id, `agent-${id}`, hash, scopes],
  )
  return { id, apiKey: key }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

before(async () => {
  process.env.NEXUM_REQUIRE_AGE = 'false'

  await startDb()

  // Force auth OFF for the majority of tests. We mutate config directly because
  // the config module is already evaluated by the time startDb() imports it.
  const { config } = await import('../../src/config.js')
  config.AUTH_OFF = true

  // Import route registrations AFTER db is ready so migrate() has run.
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
  await stopDb()
})

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('POST /synthesize creates a block with origin:synthesized and synth_status:published', async () => {
  const { config } = await import('../../src/config.js')
  config.AUTH_OFF = true

  const corpusId = await createCorpus()
  const srcId = await createSourceBlock(corpusId)

  // AUTH_OFF → anon principal with id='anon', scopes=['*']
  const { status, body } = await post('/synthesize', {
    corpus_id: corpusId,
    content: 'Synthesized content for test',
    source_block_ids: [srcId],
    agent_entity_id: 'anon',
  })

  assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body)}`)
  const b = body as any
  assert.ok(b.id, 'response must include new block id')
  assert.equal(b.status, 'published')
  assert.deepEqual(b.sourced_from, [srcId])
  assert.ok(Array.isArray(b.link_ids) && b.link_ids.length === 1, 'must have one link_id')

  // Verify DB state
  const [block] = await query<{ origin: string; synth_status: string }>(
    `SELECT origin, synth_status FROM blocks WHERE id = $1`,
    [b.id],
  )
  assert.equal(block.origin, 'synthesized')
  assert.equal(block.synth_status, 'published')
})

test('POST /synthesize creates sourced-from links for each source_block_id', async () => {
  const { config } = await import('../../src/config.js')
  config.AUTH_OFF = true

  const corpusId = await createCorpus()
  const src1 = await createSourceBlock(corpusId)
  const src2 = await createSourceBlock(corpusId)
  const src3 = await createSourceBlock(corpusId)

  const { status, body } = await post('/synthesize', {
    corpus_id: corpusId,
    content: 'Multi-source synthesis',
    source_block_ids: [src1, src2, src3],
    agent_entity_id: 'anon',
  })

  assert.equal(status, 201, `expected 201: ${JSON.stringify(body)}`)
  const b = body as any
  assert.equal(b.link_ids.length, 3, 'must return 3 link ids')
  assert.equal(b.sourced_from.length, 3)

  // Verify relational links in DB
  const links = await query<{ src: string; rel_type: string }>(
    `SELECT src::text AS src, rel_type FROM links WHERE dst = $1 ORDER BY src`,
    [b.id],
  )
  assert.equal(links.length, 3)
  const srcSet = new Set(links.map((l) => l.src))
  assert.ok(srcSet.has(src1))
  assert.ok(srcSet.has(src2))
  assert.ok(srcSet.has(src3))
  for (const link of links) {
    assert.equal(link.rel_type, 'sourced-from')
  }
})

// ---------------------------------------------------------------------------
// Authorization: principal mismatch
// ---------------------------------------------------------------------------

test('POST /synthesize returns 403 when principal != agent_entity_id', async () => {
  const { config } = await import('../../src/config.js')

  const corpusId = await createCorpus()
  const srcId = await createSourceBlock(corpusId)
  const { id: entityId, apiKey } = await createEntity(['blocks:synthesize'])

  // Enable auth so the real entity is resolved from the Bearer token
  config.AUTH_OFF = false
  try {
    // Submit with a different agent_entity_id (not the caller's own id)
    const { status, body } = await post(
      '/synthesize',
      {
        corpus_id: corpusId,
        content: 'Should be rejected',
        source_block_ids: [srcId],
        agent_entity_id: 'not-the-right-id',
      },
      { Authorization: `Bearer ${apiKey}` },
    )

    assert.equal(status, 403, `expected 403, got ${status}: ${JSON.stringify(body)}`)
    void entityId
  } finally {
    config.AUTH_OFF = true
  }
})

// ---------------------------------------------------------------------------
// Authorization: missing blocks:synthesize scope
// ---------------------------------------------------------------------------

test('POST /synthesize returns 403 when principal lacks blocks:synthesize scope', async () => {
  const { config } = await import('../../src/config.js')

  const corpusId = await createCorpus()
  const srcId = await createSourceBlock(corpusId)
  // Entity with NO scopes
  const { id: entityId, apiKey } = await createEntity([])

  config.AUTH_OFF = false
  try {
    const { status, body } = await post(
      '/synthesize',
      {
        corpus_id: corpusId,
        content: 'Should be rejected — no scope',
        source_block_ids: [srcId],
        agent_entity_id: entityId, // correct id
      },
      { Authorization: `Bearer ${apiKey}` },
    )

    assert.equal(status, 403, `expected 403, got ${status}: ${JSON.stringify(body)}`)
  } finally {
    config.AUTH_OFF = true
  }
})

// ---------------------------------------------------------------------------
// Atomicity: malformed source_block_ids roll back the transaction
// ---------------------------------------------------------------------------

test('malformed source_block_ids cause the entire transaction to roll back', async () => {
  const { config } = await import('../../src/config.js')
  config.AUTH_OFF = true

  const corpusId = await createCorpus()
  // 'not-a-valid-uuid' will fail the FK constraint on links.src → blocks.id
  const badSrcId = 'not-a-valid-uuid'
  const uniqueContent = `rollback-test-${crypto.randomUUID()}`

  const { status } = await post('/synthesize', {
    corpus_id: corpusId,
    content: uniqueContent,
    source_block_ids: [badSrcId],
    agent_entity_id: 'anon',
  })

  // Expect a server-side error (500 from constraint violation)
  assert.ok(status >= 400, `expected error status, got ${status}`)

  // Verify no synthesized block was persisted (transaction rolled back)
  const blocks = await query<{ id: string }>(
    `SELECT id FROM blocks WHERE content = $1`,
    [uniqueContent],
  )
  assert.equal(blocks.length, 0, 'no block should persist when transaction rolls back')
})

// ---------------------------------------------------------------------------
// Validation: missing required fields
// ---------------------------------------------------------------------------

test('POST /synthesize returns 400 when corpus_id is missing', async () => {
  const { config } = await import('../../src/config.js')
  config.AUTH_OFF = true

  const { status } = await post('/synthesize', {
    content: 'x',
    source_block_ids: [crypto.randomUUID()],
    agent_entity_id: 'anon',
  })
  assert.equal(status, 400)
})

test('POST /synthesize returns 400 when source_block_ids is empty', async () => {
  const { config } = await import('../../src/config.js')
  config.AUTH_OFF = true

  const corpusId = await createCorpus()
  const { status } = await post('/synthesize', {
    corpus_id: corpusId,
    content: 'x',
    source_block_ids: [],
    agent_entity_id: 'anon',
  })
  assert.equal(status, 400)
})

test('POST /synthesize returns 404 when corpus does not exist', async () => {
  const { config } = await import('../../src/config.js')
  config.AUTH_OFF = true

  const { status } = await post('/synthesize', {
    corpus_id: crypto.randomUUID(),
    content: 'x',
    source_block_ids: [crypto.randomUUID()],
    agent_entity_id: 'anon',
  })
  assert.equal(status, 404)
})
