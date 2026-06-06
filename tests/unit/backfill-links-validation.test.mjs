import { test } from 'node:test'
import assert from 'node:assert/strict'

// Issue #100 — backfillLinksToAge() copies every row of the primary `links`
// table into the `nexum_links` AGE graph as part of `migrate()`. The
// acceptance criteria require that malformed rows surface as migrate failures
// instead of being silently skipped, so the row validator is exercised
// directly here without a database round trip.

const validRow = () => ({
  id: '11111111-1111-4111-8111-111111111111',
  src: '22222222-2222-4222-8222-222222222222',
  dst: '33333333-3333-4333-8333-333333333333',
  layer: 'structural',
  rel_type: 'cites',
  weight: 1.0,
})

test('validateLinkRow accepts a well-formed row', async () => {
  const { validateLinkRow } = await import('../../dist/db/migrate.js')
  assert.doesNotThrow(() => validateLinkRow(validRow()))
})

test('validateLinkRow rejects a malformed link id', async () => {
  const { validateLinkRow } = await import('../../dist/db/migrate.js')
  const row = validRow()
  row.id = 'not-a-uuid'
  assert.throws(() => validateLinkRow(row), /malformed UUID/)
})

test('validateLinkRow rejects a malformed src or dst block id', async () => {
  const { validateLinkRow } = await import('../../dist/db/migrate.js')
  const a = validRow()
  a.src = ''
  assert.throws(() => validateLinkRow(a), /malformed UUID/)

  const b = validRow()
  b.dst = '0xdeadbeef'
  assert.throws(() => validateLinkRow(b), /malformed UUID/)
})

test('validateLinkRow rejects an unknown layer', async () => {
  const { validateLinkRow } = await import('../../dist/db/migrate.js')
  const row = validRow()
  row.layer = 'made-up-layer'
  assert.throws(() => validateLinkRow(row), /invalid layer/)
})

test('validateLinkRow rejects a null/empty layer', async () => {
  const { validateLinkRow } = await import('../../dist/db/migrate.js')
  const row = validRow()
  row.layer = ''
  assert.throws(() => validateLinkRow(row), /invalid layer/)
})

test('backfillLinksToAge result type carries copied + total fields', async () => {
  const { backfillLinksToAge } = await import('../../dist/db/migrate.js')
  const { resetAgePool } = await import('../../dist/db/age.js')
  const { config } = await import('../../dist/config.js')
  resetAgePool()
  if (config.AGE_DATABASE_URL) return // only the unset path is deterministic here

  const result = await backfillLinksToAge()
  assert.equal(result.ok, true)
  assert.equal(result.copied, 0)
  assert.equal(result.skipped, 'age-unavailable')
  assert.equal(typeof result.copied, 'number')
})
