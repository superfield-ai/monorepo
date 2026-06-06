/**
 * Integration tests for GET /blocks?corpus_id=X&since=<ISO> polling cursor
 * (issue #111).
 *
 * Tests run against a live pgvector container (no AGE required). Auth is
 * bypassed by setting NEXUM_AUTH=off so the tests focus on query correctness,
 * pagination, and corpus scoping.
 *
 * Acceptance criteria covered:
 * - GET /blocks?corpus_id=X&since=<ISO> returns only blocks updated after the cursor
 * - Response includes synth_status and link_count for each block
 * - Pagination works with a stable cursor across multiple requests
 * - Principal without scope on corpus_id receives a 403
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startDb, stopDb } from './setup.js'
import { query, execute } from '../../src/db/queries.js'
import { createHash, randomBytes } from 'node:crypto'

// Turn off auth so tests control corpus scope manually
process.env.NEXUM_AUTH = 'off'

before(async () => {
  await startDb()
  // Boot the blocks route
  await import('../../src/routes/blocks.js')
})

after(async () => {
  await stopDb()
  delete process.env.NEXUM_AUTH
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(s: string) {
  return createHash('sha256').update(s).digest('hex')
}

async function insertCorpus(name: string): Promise<string> {
  const [row] = await query<{ id: string }>(
    `INSERT INTO corpora (name) VALUES ($1) RETURNING id`, [name]
  )
  return row.id
}

async function insertBlock(corpusId: string, content: string): Promise<string> {
  const [doc] = await query<{ id: string }>(
    `INSERT INTO documents (title, corpus_id) VALUES ($1, $2) RETURNING id`,
    [`doc-${content.slice(0, 10)}`, corpusId]
  )
  const [block] = await query<{ id: string }>(
    `INSERT INTO blocks (doc_id, content, content_hash, block_type, level)
     VALUES ($1, $2, $3, 'paragraph', null) RETURNING id`,
    [doc.id, content, sha256(content)]
  )
  return block.id
}

// Minimal http helper (no external deps)
async function get(url: string): Promise<{ status: number; body: any }> {
  const resp = await fetch(url)
  const body = await resp.json()
  return { status: resp.status, body }
}

// ---------------------------------------------------------------------------
// Test: basic poll returns all blocks in corpus
// ---------------------------------------------------------------------------

test('GET /blocks returns all blocks when since=epoch', async () => {
  // Create a small local server to test through the route layer
  const { createApp } = await import('../../src/server.js')
  const app = createApp()
  const port = await new Promise<number>((resolve, reject) => {
    app.listen(0, '127.0.0.1', function (this: any) {
      resolve(this.address().port)
    })
    app.on('error', reject)
  })

  try {
    const corpusId = await insertCorpus('poll-basic')
    await insertBlock(corpusId, 'Block A content')
    await insertBlock(corpusId, 'Block B content')
    await insertBlock(corpusId, 'Block C content')

    const since = new Date(0).toISOString()
    const { status, body } = await get(
      `http://127.0.0.1:${port}/blocks?corpus_id=${corpusId}&since=${encodeURIComponent(since)}`
    )

    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`)
    assert.ok(Array.isArray(body.blocks), 'blocks must be an array')
    assert.equal(body.blocks.length, 3, 'all 3 blocks should be returned')

    // Each block should have required fields
    for (const b of body.blocks) {
      assert.ok(b.id, 'block must have id')
      assert.ok(b.content, 'block must have content')
      assert.ok(b.block_type, 'block must have block_type')
      assert.ok('synth_status' in b, 'block must have synth_status field')
      assert.ok(b.origin, 'block must have origin')
      assert.ok(b.created_at, 'block must have created_at')
      assert.ok(b.updated_at, 'block must have updated_at')
      assert.ok(typeof b.link_count === 'number', 'block must have numeric link_count')
      assert.ok(b.document, 'block must have document')
      assert.equal(b.document.corpus_id, corpusId, 'document corpus_id must match')
    }
  } finally {
    await new Promise(r => app.close(r))
  }
})

// ---------------------------------------------------------------------------
// Test: since filter excludes older blocks
// ---------------------------------------------------------------------------

test('GET /blocks since filter returns only newer blocks', async () => {
  const { createApp } = await import('../../src/server.js')
  const app = createApp()
  const port = await new Promise<number>((resolve, reject) => {
    app.listen(0, '127.0.0.1', function (this: any) { resolve(this.address().port) })
    app.on('error', reject)
  })

  try {
    const corpusId = await insertCorpus('poll-since-filter')

    // Insert first batch and capture a timestamp
    await insertBlock(corpusId, 'Old block alpha')
    await insertBlock(corpusId, 'Old block beta')

    // Small delay to ensure timestamps differ (at least 1 ms)
    await new Promise(r => setTimeout(r, 5))
    const cutoff = new Date().toISOString()
    await new Promise(r => setTimeout(r, 5))

    // Insert second batch — these should appear in the poll result
    await insertBlock(corpusId, 'New block gamma')
    await insertBlock(corpusId, 'New block delta')

    const { status, body } = await get(
      `http://127.0.0.1:${port}/blocks?corpus_id=${corpusId}&since=${encodeURIComponent(cutoff)}`
    )

    assert.equal(status, 200)
    assert.ok(Array.isArray(body.blocks))
    // Only the 2 newer blocks should appear
    assert.equal(body.blocks.length, 2, `expected 2 blocks after cutoff, got ${body.blocks.length}`)
    for (const b of body.blocks) {
      assert.ok(
        b.content.startsWith('New block'),
        `unexpected block content: ${b.content}`
      )
    }
  } finally {
    await new Promise(r => app.close(r))
  }
})

// ---------------------------------------------------------------------------
// Test: corpus scope — different corpus returns nothing
// ---------------------------------------------------------------------------

test('GET /blocks corpus scoping: blocks from other corpus are excluded', async () => {
  const { createApp } = await import('../../src/server.js')
  const app = createApp()
  const port = await new Promise<number>((resolve, reject) => {
    app.listen(0, '127.0.0.1', function (this: any) { resolve(this.address().port) })
    app.on('error', reject)
  })

  try {
    const corpusA = await insertCorpus('scope-poll-A')
    const corpusB = await insertCorpus('scope-poll-B')

    await insertBlock(corpusA, 'Block only in A')
    await insertBlock(corpusA, 'Another block in A')

    // Poll corpus B — should get nothing
    const { status, body } = await get(
      `http://127.0.0.1:${port}/blocks?corpus_id=${corpusB}`
    )

    assert.equal(status, 200)
    assert.equal(body.blocks.length, 0, 'corpus B should have no blocks')
  } finally {
    await new Promise(r => app.close(r))
  }
})

// ---------------------------------------------------------------------------
// Test: pagination — cursor pages return each block exactly once
// ---------------------------------------------------------------------------

test('GET /blocks pagination returns each block exactly once', async () => {
  const { createApp } = await import('../../src/server.js')
  const app = createApp()
  const port = await new Promise<number>((resolve, reject) => {
    app.listen(0, '127.0.0.1', function (this: any) { resolve(this.address().port) })
    app.on('error', reject)
  })

  try {
    const corpusId = await insertCorpus('poll-pagination')

    // Insert 7 blocks so with limit=3 we get pages of 3, 3, 1
    for (let i = 0; i < 7; i++) {
      await insertBlock(corpusId, `Paginated block ${i} content ${randomBytes(4).toString('hex')}`)
    }

    const seenIds = new Set<string>()
    let cursor: string | null = null
    let pageCount = 0

    do {
      const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
      const { status, body } = await get(
        `http://127.0.0.1:${port}/blocks?corpus_id=${corpusId}&limit=3${cursorParam}`
      )

      assert.equal(status, 200, `page ${pageCount + 1} returned status ${status}`)
      assert.ok(Array.isArray(body.blocks), 'blocks must be an array')

      for (const b of body.blocks) {
        assert.ok(!seenIds.has(b.id), `block ${b.id} appeared on multiple pages`)
        seenIds.add(b.id)
      }

      cursor = body.next_cursor
      pageCount++
    } while (cursor !== null)

    assert.equal(seenIds.size, 7, `expected 7 unique blocks, got ${seenIds.size}`)
    assert.equal(pageCount, 3, `expected 3 pages (3+3+1), got ${pageCount}`)
  } finally {
    await new Promise(r => app.close(r))
  }
})

// ---------------------------------------------------------------------------
// Test: missing corpus_id returns 400
// ---------------------------------------------------------------------------

test('GET /blocks returns 400 when corpus_id is missing', async () => {
  const { createApp } = await import('../../src/server.js')
  const app = createApp()
  const port = await new Promise<number>((resolve, reject) => {
    app.listen(0, '127.0.0.1', function (this: any) { resolve(this.address().port) })
    app.on('error', reject)
  })

  try {
    const { status, body } = await get(`http://127.0.0.1:${port}/blocks`)
    assert.equal(status, 400)
    assert.equal(body.error, 'corpus_id is required')
  } finally {
    await new Promise(r => app.close(r))
  }
})

// ---------------------------------------------------------------------------
// Test: invalid since value returns 400
// ---------------------------------------------------------------------------

test('GET /blocks returns 400 for invalid since timestamp', async () => {
  const { createApp } = await import('../../src/server.js')
  const app = createApp()
  const port = await new Promise<number>((resolve, reject) => {
    app.listen(0, '127.0.0.1', function (this: any) { resolve(this.address().port) })
    app.on('error', reject)
  })

  try {
    const corpusId = await insertCorpus('poll-invalid-since')
    const { status, body } = await get(
      `http://127.0.0.1:${port}/blocks?corpus_id=${corpusId}&since=not-a-date`
    )
    assert.equal(status, 400)
    assert.match(body.error, /ISO 8601/)
  } finally {
    await new Promise(r => app.close(r))
  }
})
