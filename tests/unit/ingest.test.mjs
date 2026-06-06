import { test } from 'node:test'
import assert from 'node:assert/strict'

// Import via compiled dist or via direct import
// Test parseText
test('parseText splits on double newlines', async () => {
  const { parseText } = await import('../../dist/ingest/parse-text.js')
  const blocks = parseText('Hello world\n\nSecond paragraph')
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].block_type, 'paragraph')
  assert.equal(blocks[0].content, 'Hello world')
})

test('parseMarkdown extracts headings', async () => {
  const { parseMarkdown } = await import('../../dist/ingest/parse-markdown.js')
  const blocks = parseMarkdown('# Title\n\nParagraph text')
  assert.equal(blocks[0].block_type, 'heading')
  assert.equal(blocks[0].level, 1)
  assert.equal(blocks[0].content, 'Title')
})

test('parseMarkdown extracts list items', async () => {
  const { parseMarkdown } = await import('../../dist/ingest/parse-markdown.js')
  const blocks = parseMarkdown('- item one\n- item two')
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].block_type, 'list_item')
})

test('contentHash is deterministic', async () => {
  const { contentHash } = await import('../../dist/ingest/dedup.js')
  assert.equal(contentHash('hello'), contentHash('hello'))
  assert.notEqual(contentHash('hello'), contentHash('world'))
})
