import { test } from 'node:test'
import assert from 'node:assert/strict'

test('buildEdgeText produces "<rel>: <src> -> <dst>" template', async () => {
  const { buildEdgeText } = await import('../../dist/linker/edge-embed.js')
  const text = buildEdgeText('alice owes bob', 'bob is paid', 'supports')
  assert.equal(text, 'supports: alice owes bob -> bob is paid')
})

test('buildEdgeText falls back to "related" when relType is null', async () => {
  const { buildEdgeText } = await import('../../dist/linker/edge-embed.js')
  const text = buildEdgeText('a', 'b', null)
  assert.ok(text.startsWith('related: '))
})

test('buildEdgeText truncates long snippets', async () => {
  const { buildEdgeText } = await import('../../dist/linker/edge-embed.js')
  const long = 'x'.repeat(1000)
  const text = buildEdgeText(long, long, 'cites')
  // 240 chars per side, plus rel + arrow
  assert.ok(text.length < 600, `expected truncation, got length=${text.length}`)
})

test('buildEdgeText collapses whitespace', async () => {
  const { buildEdgeText } = await import('../../dist/linker/edge-embed.js')
  const text = buildEdgeText('a   b\n\tc', 'd  e', 'cites')
  assert.equal(text, 'cites: a b c -> d e')
})

test('vectorLiteral emits pgvector literal format', async () => {
  const { vectorLiteral } = await import('../../dist/linker/edge-embed.js')
  assert.equal(vectorLiteral([1, 2, 3]), '[1,2,3]')
})

test('writeAgeEdge returns false when AGE Postgres is unreachable (no soft-fail)', async () => {
  // Phase-1 cutover (#99) removed the soft-fail / optional-companion code
  // paths in src/db/age.ts. There is no longer a "short-circuit when
  // AGE_DATABASE_URL is unset" branch — writes attempt the connection and
  // surface a boolean result. Pointing AGE at a closed port lets us assert
  // the failure mode without a live database.
  const { config } = await import('../../dist/config.js')
  const prevAge = config.AGE_DATABASE_URL
  config.AGE_DATABASE_URL = 'postgresql://nexum:nexum@127.0.0.1:1/nexum_no_age'
  try {
    const { resetAgePool, writeAgeEdge } = await import('../../dist/db/age.js')
    resetAgePool()
    const ok = await writeAgeEdge({ src: 'a', dst: 'b', layer: 'ai', relType: 'supports', weight: 1 })
    assert.equal(ok, false)
  } finally {
    config.AGE_DATABASE_URL = prevAge
    const { resetAgePool } = await import('../../dist/db/age.js')
    resetAgePool()
  }
})
