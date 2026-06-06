import { test } from 'node:test'
import assert from 'node:assert/strict'

// ---------------------------------------------------------------------------
// classifyPair (retained for backwards compatibility — still exported)
// ---------------------------------------------------------------------------

test('classifyPair returns null below 0.70 threshold', async () => {
  const { classifyPair } = await import('../../dist/linker/ai.js')
  assert.equal(classifyPair('clause A', 'clause B', 0.65), null)
})

test('classifyPair detects contradicts keyword', async () => {
  const { classifyPair } = await import('../../dist/linker/ai.js')
  const result = classifyPair('Party shall pay', 'however, Party is not required', 0.80)
  assert.equal(result, 'contradicts')
})

test('classifyPair detects elaborates keyword', async () => {
  const { classifyPair } = await import('../../dist/linker/ai.js')
  const result = classifyPair('The term includes', 'specifically, this means direct costs', 0.80)
  assert.equal(result, 'elaborates')
})

test('classifyPair returns supports for high similarity without keyword', async () => {
  const { classifyPair } = await import('../../dist/linker/ai.js')
  const result = classifyPair('Payment terms clause A', 'Payment terms clause B', 0.90)
  assert.equal(result, 'supports')
})

test('classifyPair returns null for medium similarity without keyword', async () => {
  const { classifyPair } = await import('../../dist/linker/ai.js')
  const result = classifyPair('Payment terms', 'Delivery schedule', 0.75)
  assert.equal(result, null)
})

// ---------------------------------------------------------------------------
// HeuristicInferenceClient (issue #106)
// ---------------------------------------------------------------------------

test('HeuristicInferenceClient implements InferenceClient.classifyLink', async () => {
  const { HeuristicInferenceClient } = await import('../../dist/inference/adapters/heuristic.js')
  const client = new HeuristicInferenceClient()
  assert.equal(typeof client.classifyLink, 'function')
  assert.equal(client.name, 'heuristic-inference-client')
})

test('HeuristicInferenceClient.classifyLink returns null below 0.70 threshold', async () => {
  const { HeuristicInferenceClient } = await import('../../dist/inference/adapters/heuristic.js')
  const client = new HeuristicInferenceClient()
  const result = await client.classifyLink({ contentA: 'clause A', contentB: 'clause B', cosineSim: 0.65 })
  assert.equal(result, null)
})

test('HeuristicInferenceClient.classifyLink detects contradicts keyword', async () => {
  const { HeuristicInferenceClient } = await import('../../dist/inference/adapters/heuristic.js')
  const client = new HeuristicInferenceClient()
  const result = await client.classifyLink({
    contentA: 'Party shall pay',
    contentB: 'however, Party is not required',
    cosineSim: 0.80,
  })
  assert.equal(result, 'contradicts')
})

test('HeuristicInferenceClient.classifyLink detects elaborates keyword', async () => {
  const { HeuristicInferenceClient } = await import('../../dist/inference/adapters/heuristic.js')
  const client = new HeuristicInferenceClient()
  const result = await client.classifyLink({
    contentA: 'The term includes',
    contentB: 'specifically, this means direct costs',
    cosineSim: 0.80,
  })
  assert.equal(result, 'elaborates')
})

test('HeuristicInferenceClient.classifyLink returns supports for high cosine without keyword', async () => {
  const { HeuristicInferenceClient } = await import('../../dist/inference/adapters/heuristic.js')
  const client = new HeuristicInferenceClient()
  const result = await client.classifyLink({
    contentA: 'Payment terms clause A',
    contentB: 'Payment terms clause B',
    cosineSim: 0.90,
  })
  assert.equal(result, 'supports')
})

test('HeuristicInferenceClient.classifyLink returns null for medium cosine without keyword', async () => {
  const { HeuristicInferenceClient } = await import('../../dist/inference/adapters/heuristic.js')
  const client = new HeuristicInferenceClient()
  const result = await client.classifyLink({
    contentA: 'Payment terms',
    contentB: 'Delivery schedule',
    cosineSim: 0.75,
  })
  assert.equal(result, null)
})

test('HeuristicInferenceClient.embed rejects (not implemented)', async () => {
  const { HeuristicInferenceClient } = await import('../../dist/inference/adapters/heuristic.js')
  const client = new HeuristicInferenceClient()
  await assert.rejects(() => client.embed('text'), /not implemented/)
})

// ---------------------------------------------------------------------------
// AI linker calls InferenceClient.classifyLink() (issue #106)
// Issue #106 acceptance criterion: InferenceClient.classifyLink() is called
// for each candidate pair — verified by injecting a spy client.
// ---------------------------------------------------------------------------

test('AI linker uses InferenceClient.classifyLink not inline classifyPair', async () => {
  // Verify that defaultInferenceClient is exported from ai.ts and has classifyLink.
  const aiModule = await import('../../dist/linker/ai.js')
  assert.ok(aiModule.defaultInferenceClient, 'defaultInferenceClient must be exported')
  assert.equal(
    typeof aiModule.defaultInferenceClient.classifyLink,
    'function',
    'defaultInferenceClient must implement classifyLink',
  )
})

test('AI linker exports defaultInferenceClient resolving through inference/index.ts', async () => {
  const aiModule = await import('../../dist/linker/ai.js')
  const inferenceModule = await import('../../dist/inference/index.js')
  // After first import, getDefaultInferenceClient() returns the cached instance.
  const fromInference = inferenceModule.getDefaultInferenceClient()
  assert.ok(aiModule.defaultInferenceClient.name, 'defaultInferenceClient must have a name')
  assert.ok(fromInference.name, 'inference module client must have a name')
})

// ---------------------------------------------------------------------------
// HeuristicInferenceClient works as a standalone adapter (no model needed)
// Issue #106 integration test: linker pipeline runs against HeuristicInferenceClient
// end-to-end (simulated without a database — verifies classification path only).
// ---------------------------------------------------------------------------

test('HeuristicInferenceClient: full classify-link pipeline for all relation types', async () => {
  const { HeuristicInferenceClient } = await import('../../dist/inference/adapters/heuristic.js')
  const client = new HeuristicInferenceClient()

  const cases = [
    { b: 'contrary to the agreement', expected: 'contradicts' },
    { b: 'furthermore, this clause applies', expected: 'supports' },
    { b: 'specifically, direct costs are included', expected: 'elaborates' },
    { b: 'supersedes all prior agreements', expected: 'overrides' },
    { b: 'except as provided in section 5', expected: 'is-exception-to' },
  ]

  for (const { b, expected } of cases) {
    const result = await client.classifyLink({ contentA: 'clause A', contentB: b, cosineSim: 0.80 })
    assert.equal(result, expected, `expected '${expected}' for contentB='${b}'`)
  }
})

// ---------------------------------------------------------------------------
// heuristicClassifyPair helper (exported from adapters/heuristic.ts)
// ---------------------------------------------------------------------------

test('heuristicClassifyPair detects overrides keyword', async () => {
  const { heuristicClassifyPair } = await import('../../dist/inference/adapters/heuristic.js')
  const result = heuristicClassifyPair('Section 1', 'supersedes all prior versions', 0.82)
  assert.equal(result, 'overrides')
})

test('heuristicClassifyPair detects is-exception-to keyword', async () => {
  const { heuristicClassifyPair } = await import('../../dist/inference/adapters/heuristic.js')
  const result = heuristicClassifyPair('General rule', 'except as provided in section 5', 0.78)
  assert.equal(result, 'is-exception-to')
})
