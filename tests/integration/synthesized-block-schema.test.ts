/**
 * Integration tests for the phase-4 synthesized-block schema migration (issue #109).
 *
 * Acceptance criteria verified:
 *  - blocks rows include origin and synth_status columns with sane defaults
 *  - links.rel_type accepts 'sourced-from'
 *  - Migration is idempotent (re-running is a no-op)
 *
 * AGE label creation is tested in age-edges.test.ts; this suite targets the
 * Postgres schema only and uses the pgvector-only container for speed.
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startDb, stopDb } from './setup.js'
import { query, execute } from '../../src/db/queries.js'
import crypto from 'node:crypto'

before(async () => {
  await startDb()
})

after(async () => {
  await stopDb()
})

// ---------------------------------------------------------------------------
// Helper: insert a minimal document + block
// ---------------------------------------------------------------------------
async function insertBlock(opts: {
  origin?: string
  synth_status?: string | null
}): Promise<{ blockId: string; docId: string }> {
  const [corpus] = await query<{ id: string }>(
    `INSERT INTO corpora (name) VALUES ($1) RETURNING id`,
    [`schema-test-${crypto.randomUUID()}`],
  )
  const [doc] = await query<{ id: string }>(
    `INSERT INTO documents (title, corpus_id) VALUES ('Schema Test', $1) RETURNING id`,
    [corpus.id],
  )
  const content = `Block content ${crypto.randomUUID()}`
  const hash = crypto.createHash('sha256').update(content).digest('hex')

  const parts: string[] = [
    'INSERT INTO blocks (doc_id, content, content_hash, block_type',
  ]
  const values: unknown[] = [doc.id, content, hash, 'paragraph']
  let idx = 5

  if (opts.origin !== undefined) {
    parts.push(', origin')
    values.push(opts.origin)
    idx++
  }
  if (opts.synth_status !== undefined) {
    parts.push(', synth_status')
    values.push(opts.synth_status)
    idx++
  }

  const placeholders = values.map((_, i) => `$${i + 1}`).join(', ')
  const sql = parts.join('') + `) VALUES (${placeholders}) RETURNING id`

  const [block] = await query<{ id: string }>(sql, values)
  return { blockId: block.id, docId: doc.id }
}

// ---------------------------------------------------------------------------
// blocks.origin
// ---------------------------------------------------------------------------

test('blocks.origin column exists with default "source"', async () => {
  const { blockId } = await insertBlock({})
  const [row] = await query<{ origin: string }>(
    `SELECT origin FROM blocks WHERE id = $1`,
    [blockId],
  )
  assert.equal(row.origin, 'source', 'default origin must be "source"')
})

test('blocks.origin accepts "synthesized"', async () => {
  const { blockId } = await insertBlock({ origin: 'synthesized' })
  const [row] = await query<{ origin: string }>(
    `SELECT origin FROM blocks WHERE id = $1`,
    [blockId],
  )
  assert.equal(row.origin, 'synthesized')
})

test('blocks.origin accepts "external"', async () => {
  const { blockId } = await insertBlock({ origin: 'external' })
  const [row] = await query<{ origin: string }>(
    `SELECT origin FROM blocks WHERE id = $1`,
    [blockId],
  )
  assert.equal(row.origin, 'external')
})

test('blocks.origin rejects unknown values', async () => {
  await assert.rejects(
    () => insertBlock({ origin: 'unknown-value' }),
    /check.*constraint|violates check/i,
  )
})

// ---------------------------------------------------------------------------
// blocks.synth_status
// ---------------------------------------------------------------------------

test('blocks.synth_status column exists and defaults to NULL', async () => {
  const { blockId } = await insertBlock({})
  const [row] = await query<{ synth_status: string | null }>(
    `SELECT synth_status FROM blocks WHERE id = $1`,
    [blockId],
  )
  assert.equal(row.synth_status, null, 'default synth_status must be NULL')
})

test('blocks.synth_status accepts "draft"', async () => {
  const { blockId } = await insertBlock({ synth_status: 'draft' })
  const [row] = await query<{ synth_status: string }>(
    `SELECT synth_status FROM blocks WHERE id = $1`,
    [blockId],
  )
  assert.equal(row.synth_status, 'draft')
})

test('blocks.synth_status accepts "published"', async () => {
  const { blockId } = await insertBlock({ synth_status: 'published' })
  const [row] = await query<{ synth_status: string }>(
    `SELECT synth_status FROM blocks WHERE id = $1`,
    [blockId],
  )
  assert.equal(row.synth_status, 'published')
})

test('blocks.synth_status accepts "stale"', async () => {
  const { blockId } = await insertBlock({ synth_status: 'stale' })
  const [row] = await query<{ synth_status: string }>(
    `SELECT synth_status FROM blocks WHERE id = $1`,
    [blockId],
  )
  assert.equal(row.synth_status, 'stale')
})

test('blocks.synth_status rejects unknown values', async () => {
  await assert.rejects(
    () => insertBlock({ synth_status: 'unknown-status' }),
    /check.*constraint|violates check/i,
  )
})

// ---------------------------------------------------------------------------
// links.rel_type — sourced-from
// ---------------------------------------------------------------------------

test('links.rel_type accepts "sourced-from"', async () => {
  // Create two blocks to link
  const { blockId: srcId, docId } = await insertBlock({ origin: 'source' })
  const { blockId: dstId } = await insertBlock({ origin: 'synthesized', synth_status: 'draft' })

  const [link] = await query<{ id: string; rel_type: string }>(
    `INSERT INTO links (src, dst, layer, rel_type, provenance)
     VALUES ($1, $2, 'ai', 'sourced-from', '{"model":"test","version":"0","confidence":1,"created_at":"now"}')
     RETURNING id, rel_type`,
    [srcId, dstId],
  )
  assert.equal(link.rel_type, 'sourced-from')
  void docId
})

// ---------------------------------------------------------------------------
// Idempotent re-migration
// ---------------------------------------------------------------------------

test('migration is idempotent — re-running does not throw', async () => {
  const { migrate } = await import('../../src/db/migrate.js')
  await assert.doesNotReject(migrate())
})

test('blocks schema is intact after re-migration', async () => {
  const cols = await query<{ column_name: string; column_default: string | null; is_nullable: string }>(
    `SELECT column_name, column_default, is_nullable
       FROM information_schema.columns
      WHERE table_name = 'blocks'
        AND column_name IN ('origin', 'synth_status')
      ORDER BY column_name`,
  )
  const byName = Object.fromEntries(cols.map(c => [c.column_name, c]))

  assert.ok(byName['origin'], 'origin column must exist after re-migration')
  assert.ok(
    byName['origin'].column_default?.includes('source'),
    'origin default must include "source"',
  )

  assert.ok(byName['synth_status'], 'synth_status column must exist after re-migration')
  assert.equal(byName['synth_status'].is_nullable, 'YES', 'synth_status must be nullable')
})
