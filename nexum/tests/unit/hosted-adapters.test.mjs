/**
 * Unit tests for hosted-provider adapters (issue #108).
 *
 * Verifies that:
 *   - AnthropicInferenceClient implements InferenceClient (compile-time, via
 *     shape assertions at runtime)
 *   - OpenAiInferenceClient implements InferenceClient (same)
 *   - Both adapters satisfy the interface methods and have the correct `name`
 *   - classifyLink() fast-paths to null when cosineSim < 0.70 (no API call)
 *   - classifyLink() calls the API when cosineSim >= 0.70 (using injected stub)
 *   - score() normalises to [0, 1] (using injected stub)
 *   - embed() rejects for Anthropic (not supported)
 *   - embed() calls the API for OpenAI (using injected stub)
 *   - retrieve() rejects for both adapters (database access required)
 *   - Methods reject with ANTHROPIC_API_KEY / OPENAI_API_KEY error when
 *     no key is configured
 *
 * Tests run WITHOUT a real API key by using the injected fetch seam.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

// ---------------------------------------------------------------------------
// Imports (run against the compiled dist build)
// ---------------------------------------------------------------------------

const {
  AnthropicInferenceClient,
  injectAnthropicFetchForTest,
  resetAnthropicFetchForTest,
} = await import('../../dist/inference/adapters/anthropic.js')

const {
  OpenAiInferenceClient,
  injectOpenAiChatFetchForTest,
  resetOpenAiChatFetchForTest,
  injectOpenAiEmbedFetchForTest,
  resetOpenAiEmbedFetchForTest,
} = await import('../../dist/inference/adapters/openai.js')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Assert that `client` has all required InferenceClient methods (runtime
 * proxy for the compile-time interface check).
 */
function assertImplementsInferenceClient(client, adapterName) {
  assert.equal(typeof client.name, 'string', `${adapterName}.name must be a string`)
  assert.equal(typeof client.embed, 'function', `${adapterName}.embed must be a function`)
  assert.equal(typeof client.retrieve, 'function', `${adapterName}.retrieve must be a function`)
  assert.equal(typeof client.score, 'function', `${adapterName}.score must be a function`)
  assert.equal(typeof client.classifyLink, 'function', `${adapterName}.classifyLink must be a function`)
}

// ---------------------------------------------------------------------------
// AnthropicInferenceClient — interface compliance
// ---------------------------------------------------------------------------

test('AnthropicInferenceClient implements InferenceClient interface', () => {
  const client = new AnthropicInferenceClient({ apiKey: 'test-key' })
  assertImplementsInferenceClient(client, 'AnthropicInferenceClient')
  assert.equal(client.name, 'anthropic-inference-client')
})

test('AnthropicInferenceClient.embed() rejects (Anthropic has no embedding endpoint)', async () => {
  const client = new AnthropicInferenceClient({ apiKey: 'test-key' })
  await assert.rejects(
    () => client.embed('hello world'),
    /embedding endpoint/i,
  )
})

test('AnthropicInferenceClient.retrieve() rejects (database access required)', async () => {
  const client = new AnthropicInferenceClient({ apiKey: 'test-key' })
  await assert.rejects(
    () => client.retrieve('query', 'vector'),
    /database access/i,
  )
})

test('AnthropicInferenceClient.classifyLink() fast-paths null when cosineSim < 0.70', async () => {
  const client = new AnthropicInferenceClient({ apiKey: 'test-key' })
  // No API key needed — fast-path returns null before making any HTTP call.
  const result = await client.classifyLink({ contentA: 'A', contentB: 'B', cosineSim: 0.5 })
  assert.equal(result, null)
})

test('AnthropicInferenceClient.classifyLink() calls API when cosineSim >= 0.70', async () => {
  injectAnthropicFetchForTest(async (_url, _body, _key) => ({
    content: [{ type: 'text', text: 'supports' }],
  }))
  try {
    const client = new AnthropicInferenceClient({ apiKey: 'test-key' })
    const result = await client.classifyLink({
      contentA: 'Study A shows X.',
      contentB: 'Study B replicates X.',
      cosineSim: 0.85,
    })
    assert.equal(result, 'supports')
  } finally {
    resetAnthropicFetchForTest()
  }
})

test('AnthropicInferenceClient.classifyLink() returns null for unrecognised labels', async () => {
  injectAnthropicFetchForTest(async (_url, _body, _key) => ({
    content: [{ type: 'text', text: 'unknown-label' }],
  }))
  try {
    const client = new AnthropicInferenceClient({ apiKey: 'test-key' })
    const result = await client.classifyLink({
      contentA: 'A',
      contentB: 'B',
      cosineSim: 0.90,
    })
    assert.equal(result, null)
  } finally {
    resetAnthropicFetchForTest()
  }
})

test('AnthropicInferenceClient.score() normalises to [0, 1]', async () => {
  injectAnthropicFetchForTest(async (_url, _body, _key) => ({
    content: [{ type: 'text', text: 'Block 0: 8\nBlock 1: 3' }],
  }))
  try {
    const client = new AnthropicInferenceClient({ apiKey: 'test-key' })
    const scores = await client.score('query', [
      { blockId: 'b1', score: 0.5, text: 'evidence one' },
      { blockId: 'b2', score: 0.3, text: 'evidence two' },
    ])
    assert.equal(scores.length, 2)
    assert.equal(scores[0].blockId, 'b1')
    assert.ok(scores[0].score >= 0 && scores[0].score <= 1, 'score must be in [0, 1]')
    assert.equal(scores[1].blockId, 'b2')
    assert.ok(scores[1].score >= 0 && scores[1].score <= 1, 'score must be in [0, 1]')
  } finally {
    resetAnthropicFetchForTest()
  }
})

test('AnthropicInferenceClient.score() returns [] for empty evidence', async () => {
  const client = new AnthropicInferenceClient({ apiKey: 'test-key' })
  const scores = await client.score('query', [])
  assert.deepEqual(scores, [])
})

test('AnthropicInferenceClient rejects score/classifyLink when no API key', async () => {
  // Unset env var — constructor picks up empty string if unset.
  const client = new AnthropicInferenceClient({ apiKey: '' })
  await assert.rejects(
    () => client.score('q', [{ blockId: 'b', score: 0.5 }]),
    /ANTHROPIC_API_KEY/,
  )
  await assert.rejects(
    () => client.classifyLink({ contentA: 'A', contentB: 'B', cosineSim: 0.9 }),
    /ANTHROPIC_API_KEY/,
  )
})

// ---------------------------------------------------------------------------
// OpenAiInferenceClient — interface compliance
// ---------------------------------------------------------------------------

test('OpenAiInferenceClient implements InferenceClient interface', () => {
  const client = new OpenAiInferenceClient({ apiKey: 'test-key' })
  assertImplementsInferenceClient(client, 'OpenAiInferenceClient')
  assert.equal(client.name, 'openai-inference-client')
})

test('OpenAiInferenceClient.embed() calls the Embeddings API', async () => {
  const mockEmbedding = [0.1, 0.2, 0.3]
  injectOpenAiEmbedFetchForTest(async (_url, _body, _key) => ({
    data: [{ embedding: mockEmbedding }],
  }))
  try {
    const client = new OpenAiInferenceClient({ apiKey: 'test-key' })
    const result = await client.embed('hello world')
    assert.deepEqual(result, mockEmbedding)
  } finally {
    resetOpenAiEmbedFetchForTest()
  }
})

test('OpenAiInferenceClient.retrieve() rejects (database access required)', async () => {
  const client = new OpenAiInferenceClient({ apiKey: 'test-key' })
  await assert.rejects(
    () => client.retrieve('query', 'vector'),
    /database access/i,
  )
})

test('OpenAiInferenceClient.classifyLink() fast-paths null when cosineSim < 0.70', async () => {
  const client = new OpenAiInferenceClient({ apiKey: 'test-key' })
  const result = await client.classifyLink({ contentA: 'A', contentB: 'B', cosineSim: 0.5 })
  assert.equal(result, null)
})

test('OpenAiInferenceClient.classifyLink() calls Chat Completions when cosineSim >= 0.70', async () => {
  injectOpenAiChatFetchForTest(async (_url, _body, _key) => ({
    choices: [{ message: { content: 'contradicts' } }],
  }))
  try {
    const client = new OpenAiInferenceClient({ apiKey: 'test-key' })
    const result = await client.classifyLink({
      contentA: 'X causes Y.',
      contentB: 'Y does not depend on X.',
      cosineSim: 0.75,
    })
    assert.equal(result, 'contradicts')
  } finally {
    resetOpenAiChatFetchForTest()
  }
})

test('OpenAiInferenceClient.classifyLink() returns null for unrecognised labels', async () => {
  injectOpenAiChatFetchForTest(async (_url, _body, _key) => ({
    choices: [{ message: { content: 'maybe' } }],
  }))
  try {
    const client = new OpenAiInferenceClient({ apiKey: 'test-key' })
    const result = await client.classifyLink({
      contentA: 'A',
      contentB: 'B',
      cosineSim: 0.80,
    })
    assert.equal(result, null)
  } finally {
    resetOpenAiChatFetchForTest()
  }
})

test('OpenAiInferenceClient.score() normalises to [0, 1]', async () => {
  injectOpenAiChatFetchForTest(async (_url, _body, _key) => ({
    choices: [{ message: { content: 'Block 0: 9\nBlock 1: 2' } }],
  }))
  try {
    const client = new OpenAiInferenceClient({ apiKey: 'test-key' })
    const scores = await client.score('query', [
      { blockId: 'b1', score: 0.7, text: 'first block' },
      { blockId: 'b2', score: 0.4, text: 'second block' },
    ])
    assert.equal(scores.length, 2)
    assert.equal(scores[0].blockId, 'b1')
    assert.ok(scores[0].score >= 0 && scores[0].score <= 1)
    assert.equal(scores[1].blockId, 'b2')
    assert.ok(scores[1].score >= 0 && scores[1].score <= 1)
  } finally {
    resetOpenAiChatFetchForTest()
  }
})

test('OpenAiInferenceClient.score() returns [] for empty evidence', async () => {
  const client = new OpenAiInferenceClient({ apiKey: 'test-key' })
  const scores = await client.score('query', [])
  assert.deepEqual(scores, [])
})

test('OpenAiInferenceClient rejects embed/score/classifyLink when no API key', async () => {
  const client = new OpenAiInferenceClient({ apiKey: '' })
  await assert.rejects(
    () => client.embed('text'),
    /OPENAI_API_KEY/,
  )
  await assert.rejects(
    () => client.score('q', [{ blockId: 'b', score: 0.5 }]),
    /OPENAI_API_KEY/,
  )
  await assert.rejects(
    () => client.classifyLink({ contentA: 'A', contentB: 'B', cosineSim: 0.9 }),
    /OPENAI_API_KEY/,
  )
})
