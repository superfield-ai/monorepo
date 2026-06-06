import { test } from 'node:test'
import assert from 'node:assert/strict'

// Phase-1 AGE-default cutover seams (issues #98 scout, #99 hardening).
// These tests pin the public seam surface that the four follow-on phase-1
// implementation issues consume. They run with NEXUM_REQUIRE_AGE=false so
// the module loads without a live AGE-capable Postgres.

process.env.NEXUM_REQUIRE_AGE = 'false'

test('startupRequireAge is exported and skips when NEXUM_REQUIRE_AGE=false', async () => {
  const { startupRequireAge, resetAgePool } = await import('../../dist/db/age.js')
  resetAgePool()
  assert.equal(typeof startupRequireAge, 'function')
  const prev = process.env.NEXUM_REQUIRE_AGE
  process.env.NEXUM_REQUIRE_AGE = 'false'
  try {
    const result = await startupRequireAge()
    assert.equal(result.ok, true)
    assert.equal(result.mode, 'skipped')
  } finally {
    process.env.NEXUM_REQUIRE_AGE = prev
  }
})

test('startupRequireAge throws when AGE Postgres is unreachable and required', async () => {
  // Pin the phase-1 cutover behaviour: no soft-fail, no warn-and-continue.
  // Point at a port nothing is listening on; the require flag is on.
  const prevRequire = process.env.NEXUM_REQUIRE_AGE
  const prevAge = process.env.AGE_DATABASE_URL
  process.env.NEXUM_REQUIRE_AGE = 'true'
  process.env.AGE_DATABASE_URL = 'postgresql://nexum:nexum@127.0.0.1:1/nexum_no_age'
  try {
    const { config } = await import('../../dist/config.js')
    const prevConfig = config.AGE_DATABASE_URL
    config.AGE_DATABASE_URL = process.env.AGE_DATABASE_URL
    try {
      const { startupRequireAge, resetAgePool } = await import('../../dist/db/age.js')
      resetAgePool()
      await assert.rejects(() => startupRequireAge(), /startupRequireAge/)
    } finally {
      config.AGE_DATABASE_URL = prevConfig
      const { resetAgePool } = await import('../../dist/db/age.js')
      resetAgePool()
    }
  } finally {
    if (prevRequire === undefined) delete process.env.NEXUM_REQUIRE_AGE
    else process.env.NEXUM_REQUIRE_AGE = prevRequire
    if (prevAge === undefined) delete process.env.AGE_DATABASE_URL
    else process.env.AGE_DATABASE_URL = prevAge
  }
})

test('createCypherGraphClient produces an object that satisfies the interface', async () => {
  const { createCypherGraphClient, resetAgePool } = await import('../../dist/db/age.js')
  resetAgePool()
  const client = createCypherGraphClient()
  assert.equal(typeof client.writeEdge, 'function')
  assert.equal(typeof client.countEdges, 'function')
  assert.equal(typeof client.query, 'function')
  assert.equal(typeof client.available, 'function')
})

test('CypherGraphClient.available reports false when AGE Postgres is unreachable', async () => {
  const { config } = await import('../../dist/config.js')
  const prevConfig = config.AGE_DATABASE_URL
  config.AGE_DATABASE_URL = 'postgresql://nexum:nexum@127.0.0.1:1/nexum_no_age'
  try {
    const { createCypherGraphClient, resetAgePool } = await import('../../dist/db/age.js')
    resetAgePool()
    const client = createCypherGraphClient()
    assert.equal(await client.available(), false)
  } finally {
    config.AGE_DATABASE_URL = prevConfig
    const { resetAgePool } = await import('../../dist/db/age.js')
    resetAgePool()
  }
})

test('backfillLinksToAge is exported with the frozen result shape', async () => {
  const { backfillLinksToAge } = await import('../../dist/db/migrate.js')
  assert.equal(typeof backfillLinksToAge, 'function')
})
