import { test } from 'node:test'
import assert from 'node:assert/strict'

test('extractCitationRefs finds § references', async () => {
  const { extractCitationRefs } = await import('../../dist/linker/structural.js')
  const refs = extractCitationRefs('See § 3.2 and § 4.1 for details')
  assert.ok(refs.includes('section:3.2'))
  assert.ok(refs.includes('section:4.1'))
})

test('extractCitationRefs finds Section references', async () => {
  const { extractCitationRefs } = await import('../../dist/linker/structural.js')
  const refs = extractCitationRefs('Pursuant to Section 5.3 of this Agreement')
  assert.ok(refs.includes('section:5.3'))
})

test('extractCitationRefs finds Exhibit references', async () => {
  const { extractCitationRefs } = await import('../../dist/linker/structural.js')
  const refs = extractCitationRefs('As described in Exhibit A')
  assert.ok(refs.includes('exhibit:A'))
})

test('extractCitationRefs returns empty array for no citations', async () => {
  const { extractCitationRefs } = await import('../../dist/linker/structural.js')
  const refs = extractCitationRefs('This is a general paragraph with no citations.')
  assert.equal(refs.length, 0)
})

test('extractCitationRefs deduplicates same citation', async () => {
  const { extractCitationRefs } = await import('../../dist/linker/structural.js')
  const refs = extractCitationRefs('See § 3.2 and also § 3.2')
  const count = refs.filter(r => r === 'section:3.2').length
  assert.equal(count, 1)
})
