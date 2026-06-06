import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { route, createApp, send } from '../../dist/server.js'

// Helper: make an HTTP request and return { statusCode, headers, body }
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString()
        let body
        try { body = JSON.parse(raw) } catch { body = raw }
        resolve({ statusCode: res.statusCode, headers: res.headers, body })
      })
    }).on('error', reject)
  })
}

function httpRequest(method, url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const options = { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname, method }
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
    req.end()
  })
}

test('registered route is called with correct path params', async () => {
  route('GET', '/items/:id', async (_req, res, params) => {
    send(res, 200, { id: params.id })
  })
  const app = createApp()
  await new Promise((resolve, reject) => {
    app.listen(0, resolve)
    app.on('error', reject)
  })
  const port = app.address().port
  try {
    const { statusCode, body } = await httpGet(`http://localhost:${port}/items/42`)
    assert.equal(statusCode, 200)
    assert.equal(body.id, '42')
  } finally {
    await new Promise((resolve) => app.close(resolve))
  }
})

test('unknown route returns 404 JSON response', async () => {
  const app = createApp()
  await new Promise((resolve, reject) => {
    app.listen(0, resolve)
    app.on('error', reject)
  })
  const port = app.address().port
  try {
    const { statusCode, body } = await httpGet(`http://localhost:${port}/no-such-route`)
    assert.equal(statusCode, 404)
    assert.equal(body.error, 'not_found')
  } finally {
    await new Promise((resolve) => app.close(resolve))
  }
})

test('CORS headers are present on all responses', async () => {
  const app = createApp()
  await new Promise((resolve, reject) => {
    app.listen(0, resolve)
    app.on('error', reject)
  })
  const port = app.address().port
  try {
    const { headers } = await httpGet(`http://localhost:${port}/no-such-route`)
    assert.equal(headers['access-control-allow-origin'], '*')
    assert.ok(headers['access-control-allow-methods'])
  } finally {
    await new Promise((resolve) => app.close(resolve))
  }
})

test('OPTIONS request returns 204 with CORS headers', async () => {
  const app = createApp()
  await new Promise((resolve, reject) => {
    app.listen(0, resolve)
    app.on('error', reject)
  })
  const port = app.address().port
  try {
    const { statusCode, headers } = await httpRequest('OPTIONS', `http://localhost:${port}/health`)
    assert.equal(statusCode, 204)
    assert.equal(headers['access-control-allow-origin'], '*')
  } finally {
    await new Promise((resolve) => app.close(resolve))
  }
})
