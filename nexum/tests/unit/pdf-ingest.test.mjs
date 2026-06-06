import { test } from 'node:test'
import assert from 'node:assert/strict'

test('parsePdf is exported as a function', async () => {
  const { parsePdf } = await import('../../dist/ingest/parse-pdf.js')
  assert.equal(typeof parsePdf, 'function')
})

test('parseTextLines returns empty array for blank text', async () => {
  const { parseTextLines } = await import('../../dist/ingest/parse-pdf.js')
  const blocks = parseTextLines('')
  assert.deepEqual(blocks, [])
})

test('parseTextLines classifies ALL-CAPS short lines as headings', async () => {
  const { parseTextLines } = await import('../../dist/ingest/parse-pdf.js')
  const blocks = parseTextLines('INTRODUCTION\n\nSome paragraph text here.')
  assert.equal(blocks[0].block_type, 'heading')
  assert.equal(blocks[0].level, 1)
  assert.equal(blocks[0].content, 'INTRODUCTION')
  assert.equal(blocks[0].meta.parse_confidence, 0.75)
})

test('parseTextLines treats indented bullet lines as list_item', async () => {
  const { parseTextLines } = await import('../../dist/ingest/parse-pdf.js')
  const blocks = parseTextLines('    - first item\n    - second item')
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].block_type, 'list_item')
  assert.equal(blocks[0].meta.parse_confidence, 0.8)
})

test('parseTextLines treats indented numbered lines as list_item', async () => {
  const { parseTextLines } = await import('../../dist/ingest/parse-pdf.js')
  const blocks = parseTextLines('  1. first item')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].block_type, 'list_item')
})

test('parseTextLines merges consecutive non-empty lines into one paragraph', async () => {
  const { parseTextLines } = await import('../../dist/ingest/parse-pdf.js')
  const blocks = parseTextLines('This is line one\nThis is line two\nThis is line three.')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].block_type, 'paragraph')
  assert.ok(blocks[0].content.includes('line one'))
  assert.ok(blocks[0].content.includes('line three'))
})

test('classifyBlock gives 0.9 confidence to sentences ending with punctuation', async () => {
  const { classifyBlock } = await import('../../dist/ingest/parse-pdf.js')
  const block = classifyBlock('This is a complete sentence that ends properly.')
  assert.equal(block.block_type, 'paragraph')
  assert.equal(block.meta.parse_confidence, 0.9)
})

test('classifyBlock gives 0.75 confidence to long text without terminal punctuation', async () => {
  const { classifyBlock } = await import('../../dist/ingest/parse-pdf.js')
  const block = classifyBlock('This is a long enough line that does not end with punctuation at all here')
  assert.equal(block.block_type, 'paragraph')
  assert.equal(block.meta.parse_confidence, 0.75)
})

test('classifyBlock gives 0.6 confidence to short non-sentence text', async () => {
  const { classifyBlock } = await import('../../dist/ingest/parse-pdf.js')
  const block = classifyBlock('Page 1 of 10')
  assert.equal(block.block_type, 'paragraph')
  assert.equal(block.meta.parse_confidence, 0.6)
})

test('parseTextLines skips lines that are purely lowercase all-caps check', async () => {
  const { parseTextLines } = await import('../../dist/ingest/parse-pdf.js')
  // lowercase text should NOT become a heading even if short
  const blocks = parseTextLines('not a heading\n\nThis is a real paragraph.')
  assert.equal(blocks[0].block_type, 'paragraph')
  assert.equal(blocks[0].content, 'not a heading')
})

test('parseTextLines handles multiple paragraphs separated by blank lines', async () => {
  const { parseTextLines } = await import('../../dist/ingest/parse-pdf.js')
  const input = 'First paragraph text.\n\nSecond paragraph text.\n\nThird paragraph text.'
  const blocks = parseTextLines(input)
  assert.equal(blocks.length, 3)
  assert.ok(blocks.every(b => b.block_type === 'paragraph'))
})
