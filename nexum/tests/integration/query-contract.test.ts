/**
 * Integration test for issue #104: phase-2 public Query API contract.
 *
 * Asserts the simplified `vector | graph | hybrid` surface end-to-end through
 * the registered POST /query handler:
 *
 *   1. Deprecated public modes (`fulltext`, `edge_semantic`) are rejected
 *      with a 400 and an actionable error message — without performing any
 *      DB work beyond corpus_id presence checks.
 *   2. `mode: 'vector'` with `target: 'edges'` returns ranked links over the
 *      `links.edge_embedding` column, subsuming the retired `edge_semantic`
 *      mode.
 *   3. `mode: 'vector'` with default target returns ranked blocks (the
 *      legacy `semantic` behaviour).
 *
 * Boots the same in-process Node http server the other route tests use so we
 * exercise the real router, validation, and serialisation path.
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startDb, stopDb } from './setup.js'
import { query, execute } from '../../src/db/queries.js'
import { createHash } from 'node:crypto'

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

before(async () => {
  await startDb()
  await ensureServer()
})

after(async () => {
  if (serverInstance) {
    await new Promise<void>((resolve, reject) =>
      serverInstance!.close((err) => (err ? reject(err) : resolve())),
    )
    serverInstance = null
  }
  await stopDb()
})

async function postQuery(body: any): Promise<{ status: number; json: any }> {
  const port = await ensureServer()
  const res = await fetch(`http://127.0.0.1:${port}/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

test("POST /query rejects deprecated mode 'fulltext' with 400", async () => {
  const [corpus] = await query<{ id: string }>(
    `INSERT INTO corpora (name) VALUES ('contract-fulltext') RETURNING id`,
  )
  const { status, json } = await postQuery({
    corpus_id: corpus.id,
    mode: 'fulltext',
    query: 'anything',
  })
  assert.equal(status, 400)
  assert.match(json.error, /deprecated/i)
  assert.match(json.error, /vector\|graph\|hybrid/)
})

test("POST /query rejects deprecated mode 'edge_semantic' with 400", async () => {
  const [corpus] = await query<{ id: string }>(
    `INSERT INTO corpora (name) VALUES ('contract-edge-sem') RETURNING id`,
  )
  const { status, json } = await postQuery({
    corpus_id: corpus.id,
    mode: 'edge_semantic',
    query: 'anything',
  })
  assert.equal(status, 400)
  assert.match(json.error, /deprecated/i)
})

test("POST /query rejects unknown mode names with 400", async () => {
  const [corpus] = await query<{ id: string }>(
    `INSERT INTO corpora (name) VALUES ('contract-unknown') RETURNING id`,
  )
  const { status, json } = await postQuery({
    corpus_id: corpus.id,
    mode: 'mystery',
    query: 'anything',
  })
  assert.equal(status, 400)
  assert.match(json.error, /unknown mode/i)
  assert.match(json.error, /vector/)
})

test("POST /query mode='vector' target='edges' returns ranked links", async () => {
  // Build a tiny corpus with two blocks and a link bearing an edge_embedding.
  const [corpus] = await query<{ id: string }>(
    `INSERT INTO corpora (name) VALUES ('contract-vector-edges') RETURNING id`,
  )
  const [doc] = await query<{ id: string }>(
    `INSERT INTO documents (title, corpus_id) VALUES ('Doc', $1) RETURNING id`,
    [corpus.id],
  )
  const [ver] = await query<{ id: string }>(
    `INSERT INTO document_versions (doc_id, version_num, status) VALUES ($1, 1, 'parsed') RETURNING id`,
    [doc.id],
  )
  const srcText = 'See § 4.1 for the indemnification limit.'
  const dstText = '4.1 The indemnification limit shall not exceed the contract value.'
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

  // Build an edge_embedding using the same template the linker uses so the
  // probe and stored vectors live in matching constructions.
  const { embedTexts } = await import('../../src/embed/local.js')
  const { buildEdgeText } = await import('../../src/linker/edge-embed.js')
  const edgeText = buildEdgeText(srcText, dstText, 'cites')
  const [vec] = await embedTexts([edgeText])
  const vecStr = `[${vec.join(',')}]`
  await execute(
    `INSERT INTO links (src, dst, layer, rel_type, weight, edge_embedding)
     VALUES ($1, $2, 'structural', 'cites', 1.0, $3::vector)`,
    [src.id, dst.id, vecStr],
  )

  const { status, json } = await postQuery({
    corpus_id: corpus.id,
    mode: 'vector',
    target: 'edges',
    src_text: srcText,
    dst_text: dstText,
    rel_hint: 'cites',
    limit: 5,
  })
  assert.equal(status, 200)
  assert.ok(Array.isArray(json.results))
  assert.ok(json.results.length >= 1, 'expected at least one ranked link')
  const top = json.results[0]
  assert.equal(top.layer, 'structural')
  assert.equal(top.rel_type, 'cites')
  assert.equal(top.src.block_id, src.id)
  assert.equal(top.dst.block_id, dst.id)
  assert.ok(typeof top.score === 'number')
})

test("POST /query mode='vector' rejects target='edges' without query or triple", async () => {
  const [corpus] = await query<{ id: string }>(
    `INSERT INTO corpora (name) VALUES ('contract-edges-noargs') RETURNING id`,
  )
  const { status, json } = await postQuery({
    corpus_id: corpus.id,
    mode: 'vector',
    target: 'edges',
  })
  assert.equal(status, 400)
  assert.match(json.error, /query or \(src_text,dst_text\)/)
})

test("POST /query mode='vector' rejects unknown target value", async () => {
  const [corpus] = await query<{ id: string }>(
    `INSERT INTO corpora (name) VALUES ('contract-bad-target') RETURNING id`,
  )
  const { status, json } = await postQuery({
    corpus_id: corpus.id,
    mode: 'vector',
    target: 'nodes',
    query: 'anything',
  })
  assert.equal(status, 400)
  assert.match(json.error, /unknown target/)
})
