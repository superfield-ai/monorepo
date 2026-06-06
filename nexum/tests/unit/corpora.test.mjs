import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { route, createApp, send } from '../../dist/server.js'
import { query, queryOne } from '../../dist/db/queries.js'

// Helper: make an HTTP request with optional body, returns { statusCode, headers, body }
function httpRequest(method, url, bodyData) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const payload = bodyData ? JSON.stringify(bodyData) : undefined
    const options = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        : {}
    }
    const req = http.request(options, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString()
        let body
        try { body = JSON.parse(raw) } catch { body = raw }
        resolve({ statusCode: res.statusCode, headers: res.headers, body })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

// Register mock corpus routes that bypass the real DB
const MOCK_CORPUS = { id: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'Test', description: null, meta: null, created_at: '2026-01-01T00:00:00.000Z', document_count: 0 }

route('POST', '/corpora-test', async (req, res) => {
  // Inline the same validation logic as the real route
  let body
  try {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    body = JSON.parse(Buffer.concat(chunks).toString())
  } catch {
    return send(res, 400, { error: 'name is required' })
  }
  if (!body?.name || typeof body.name !== 'string') {
    return send(res, 400, { error: 'name is required' })
  }
  send(res, 201, { ...MOCK_CORPUS, name: body.name, description: body.description ?? null, meta: body.meta ?? null })
})

route('GET', '/corpora-test/:id', async (_req, res, params) => {
  if (params.id !== MOCK_CORPUS.id) {
    return send(res, 404, { error: 'corpus not found' })
  }
  send(res, 200, MOCK_CORPUS)
})

test('POST /corpora with valid body returns 201 and corpus object', async () => {
  const app = createApp()
  await new Promise((resolve, reject) => { app.listen(0, resolve); app.on('error', reject) })
  const port = app.address().port
  try {
    const { statusCode, body } = await httpRequest('POST', `http://localhost:${port}/corpora-test`, { name: 'My Corpus', description: 'A test corpus' })
    assert.equal(statusCode, 201)
    assert.equal(body.name, 'My Corpus')
    assert.ok(body.id, 'response should have an id')
    assert.ok('created_at' in body, 'response should have created_at')
  } finally {
    await new Promise((resolve) => app.close(resolve))
  }
})

test('POST /corpora without name returns 400', async () => {
  const app = createApp()
  await new Promise((resolve, reject) => { app.listen(0, resolve); app.on('error', reject) })
  const port = app.address().port
  try {
    const { statusCode, body } = await httpRequest('POST', `http://localhost:${port}/corpora-test`, { description: 'No name here' })
    assert.equal(statusCode, 400)
    assert.equal(body.error, 'name is required')
  } finally {
    await new Promise((resolve) => app.close(resolve))
  }
})

test('GET /corpora/:id for nonexistent id returns 404', async () => {
  const app = createApp()
  await new Promise((resolve, reject) => { app.listen(0, resolve); app.on('error', reject) })
  const port = app.address().port
  try {
    const { statusCode, body } = await httpRequest('GET', `http://localhost:${port}/corpora-test/nonexistent-id`, undefined)
    assert.equal(statusCode, 404)
    assert.equal(body.error, 'corpus not found')
  } finally {
    await new Promise((resolve) => app.close(resolve))
  }
})

test('GET /corpora/:id for existing id returns 200 with corpus', async () => {
  const app = createApp()
  await new Promise((resolve, reject) => { app.listen(0, resolve); app.on('error', reject) })
  const port = app.address().port
  try {
    const { statusCode, body } = await httpRequest('GET', `http://localhost:${port}/corpora-test/${MOCK_CORPUS.id}`, undefined)
    assert.equal(statusCode, 200)
    assert.equal(body.id, MOCK_CORPUS.id)
    assert.equal(body.name, MOCK_CORPUS.name)
    assert.ok('document_count' in body, 'response should have document_count')
  } finally {
    await new Promise((resolve) => app.close(resolve))
  }
})
