import { test } from 'node:test'
import assert from 'node:assert/strict'

test('generateApiKey returns key starting with nxm_ and matching hash', async () => {
  const { generateApiKey } = await import('../../dist/auth/middleware.js')
  const { createHash } = await import('node:crypto')
  const { key, hash } = generateApiKey()
  assert.ok(key.startsWith('nxm_'))
  const expectedHash = createHash('sha256').update(key).digest('hex')
  assert.equal(hash, expectedHash)
})

test('authenticate returns anon principal when AUTH_OFF=true', async () => {
  process.env.NEXUM_AUTH = 'off'
  // Reimport with fresh env
  const mod = await import('../../dist/auth/middleware.js')
  const result = await mod.authenticate({})
  assert.equal(result?.type, 'user')
  assert.ok(result?.scopes.includes('*'))
})
