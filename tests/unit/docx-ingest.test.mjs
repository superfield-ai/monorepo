import { test } from 'node:test'
import assert from 'node:assert/strict'

test('parseDocx is exported and is a function', async () => {
  const mod = await import('../../dist/ingest/parse-docx.js')
  assert.equal(typeof mod.parseDocx, 'function')
})

test('parseHtml is exported and is a function', async () => {
  const mod = await import('../../dist/ingest/parse-docx.js')
  assert.equal(typeof mod.parseHtml, 'function')
})

test('parseHtml extracts headings with correct levels', async () => {
  const { parseHtml } = await import('../../dist/ingest/parse-docx.js')
  const blocks = parseHtml('<h1>Title</h1><p>Some paragraph</p><h2>Section</h2>')
  assert.equal(blocks[0].block_type, 'heading')
  assert.equal(blocks[0].level, 1)
  assert.equal(blocks[0].content, 'Title')
  assert.equal(blocks[1].block_type, 'paragraph')
  assert.equal(blocks[1].content, 'Some paragraph')
  assert.equal(blocks[2].block_type, 'heading')
  assert.equal(blocks[2].level, 2)
})

test('parseHtml skips empty paragraphs', async () => {
  const { parseHtml } = await import('../../dist/ingest/parse-docx.js')
  const blocks = parseHtml('<p></p><p>Real content</p>')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].content, 'Real content')
})

test('parseHtml extracts list items', async () => {
  const { parseHtml } = await import('../../dist/ingest/parse-docx.js')
  const blocks = parseHtml('<ul><li>Item one</li><li>Item two</li></ul>')
  const listItems = blocks.filter(b => b.block_type === 'list_item')
  assert.equal(listItems.length, 2)
  assert.equal(listItems[0].content, 'Item one')
  assert.equal(listItems[0].level, null)
})

test('parseHtml strips inner HTML tags from content', async () => {
  const { parseHtml } = await import('../../dist/ingest/parse-docx.js')
  const blocks = parseHtml('<p><strong>Bold</strong> and <em>italic</em></p>')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].content, 'Bold and italic')
})

test('parseHtml handles all heading levels h1-h6', async () => {
  const { parseHtml } = await import('../../dist/ingest/parse-docx.js')
  const html = '<h1>H1</h1><h2>H2</h2><h3>H3</h3><h4>H4</h4><h5>H5</h5><h6>H6</h6>'
  const blocks = parseHtml(html)
  assert.equal(blocks.length, 6)
  for (let i = 0; i < 6; i++) {
    assert.equal(blocks[i].block_type, 'heading')
    assert.equal(blocks[i].level, i + 1)
  }
})
