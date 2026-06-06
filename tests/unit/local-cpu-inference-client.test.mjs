/**
 * Unit tests for LocalCpuInferenceClient (issue #105).
 *
 * These tests verify the public API contract of LocalCpuInferenceClient
 * WITHOUT loading model weights. They use two strategies:
 *
 * 1. Fast-path tests: verify behavior that does not reach the pipeline
 *    (e.g. classifyLink with cosineSim < 0.70 returns null immediately).
 *
 * 2. Mock-injected tests: use the `_injectPipelineForTest` seam (see
 *    local-cpu.ts) to inject a lightweight stub pipeline, then assert
 *    on the return shape and values.
 *
 * The tests verify:
 *   - classifyLink() returns a valid SIGNALS label (string) or null
 *   - evaluateYesNo() returns { answer: 'yes'|'no', confidence: number }
 *   - classifyLink() fast-paths to null when cosineSim < 0.70
 *   - retrieve() and score() reject (not yet implemented in local-cpu)
 *   - the client's `name` property is correct
 *   - PHASE3_DEFAULT_BACKEND is 'local-cpu' after issue #105
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

// Import the module under test (runs against the dist build).
const { LocalCpuInferenceClient } = await import('../../dist/inference/local-cpu.js')

// ---------------------------------------------------------------------------
// Inject a test-only pipeline stub via the exported seam function.
//
// LocalCpuInferenceClient exports `injectClassifierPipelineForTest(fn)` which
// replaces the module-level pipeline cache for the lifetime of the test
// process. Each test that needs the pipeline calls this first.
// ---------------------------------------------------------------------------
const { injectClassifierPipelineForTest, resetClassifierPipelineForTest } =
  await import('../../dist/inference/local-cpu.js')

const MOCK_CLASSIFY_OUTPUT = {
  labels: ['supports', 'contradicts', 'elaborates', 'overrides', 'is-exception-to'],
  scores: [0.80, 0.08, 0.06, 0.04, 0.02],
}

const MOCK_YES_NO_OUTPUT = {
  labels: ['yes', 'no'],
  scores: [0.90, 0.10],
}

function makeMockPipeline() {
  return async (_text, labels) => {
    if (
      labels.length === 2 &&
      labels.includes('yes') &&
      labels.includes('no')
    ) {
      return MOCK_YES_NO_OUTPUT
    }
    return MOCK_CLASSIFY_OUTPUT
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('LocalCpuInferenceClient has correct name', () => {
  const client = new LocalCpuInferenceClient()
  assert.equal(client.name, 'local-cpu-inference-client')
})

test('classifyLink returns null when cosineSim < 0.70 (fast-path bypass, no pipeline needed)', async () => {
  const client = new LocalCpuInferenceClient()
  // This test does NOT need the pipeline — it returns null before loading it.
  const result = await client.classifyLink({
    contentA: 'Clause A content.',
    contentB: 'Clause B content.',
    cosineSim: 0.65,
  })
  assert.equal(result, null)
})

test('classifyLink returns null when cosineSim exactly at threshold (0.69)', async () => {
  const client = new LocalCpuInferenceClient()
  const result = await client.classifyLink({
    contentA: 'Clause A.',
    contentB: 'Clause B.',
    cosineSim: 0.69,
  })
  assert.equal(result, null)
})

test('classifyLink result has correct shape: string or null (with mock pipeline)', async () => {
  injectClassifierPipelineForTest(makeMockPipeline())
  try {
    const client = new LocalCpuInferenceClient()
    const result = await client.classifyLink({
      contentA: 'The regulation requires disclosure.',
      contentB: 'Parties must report financial information.',
      cosineSim: 0.75,
    })
    // Shape check: must be string or null
    assert.ok(
      typeof result === 'string' || result === null,
      `classifyLink must return string | null, got ${typeof result}`,
    )
  } finally {
    resetClassifierPipelineForTest()
  }
})

test('classifyLink returns a valid SIGNALS label when mock scores supports at 0.80', async () => {
  injectClassifierPipelineForTest(makeMockPipeline())
  try {
    const client = new LocalCpuInferenceClient()
    const result = await client.classifyLink({
      contentA: 'Party shall pay within 30 days.',
      contentB: 'Payment is consistent with prior agreements.',
      cosineSim: 0.82,
    })
    const validLabels = ['supports', 'contradicts', 'elaborates', 'overrides', 'is-exception-to', null]
    assert.ok(
      validLabels.includes(result),
      `Expected a valid SIGNALS label or null, got: ${JSON.stringify(result)}`,
    )
    // Our mock returns 'supports' at 0.80 confidence (≥ 0.35 threshold)
    assert.equal(result, 'supports')
  } finally {
    resetClassifierPipelineForTest()
  }
})

test('evaluateYesNo returns { answer, confidence } shape (with mock pipeline)', async () => {
  injectClassifierPipelineForTest(makeMockPipeline())
  try {
    const client = new LocalCpuInferenceClient()
    const result = await client.evaluateYesNo(
      'Does the contract require written notice?',
    )
    // Shape checks
    assert.ok(
      typeof result === 'object' && result !== null,
      'evaluateYesNo must return an object',
    )
    assert.ok(
      result.answer === 'yes' || result.answer === 'no',
      `answer must be 'yes' or 'no', got: ${result.answer}`,
    )
    assert.ok(
      typeof result.confidence === 'number' &&
        result.confidence >= 0 &&
        result.confidence <= 1,
      `confidence must be a number in [0,1], got: ${result.confidence}`,
    )
  } finally {
    resetClassifierPipelineForTest()
  }
})

test('evaluateYesNo returns expected values from mock (yes at 0.90)', async () => {
  injectClassifierPipelineForTest(makeMockPipeline())
  try {
    const client = new LocalCpuInferenceClient()
    const result = await client.evaluateYesNo('Is the obligation mandatory?')
    assert.equal(result.answer, 'yes')
    assert.equal(result.confidence, 0.90)
  } finally {
    resetClassifierPipelineForTest()
  }
})

test('retrieve rejects with not-implemented message', async () => {
  const client = new LocalCpuInferenceClient()
  await assert.rejects(
    () => client.retrieve('query', 'vector'),
    /not implemented in the local-cpu backend/i,
  )
})

test('score rejects with not-implemented message', async () => {
  const client = new LocalCpuInferenceClient()
  await assert.rejects(
    () => client.score('query', [{ blockId: 'b1', score: 0.5 }]),
    /not implemented in the local-cpu backend/i,
  )
})

test('PHASE3_DEFAULT_BACKEND is local-cpu', async () => {
  const { PHASE3_DEFAULT_BACKEND } = await import('../../dist/inference/index.js')
  assert.equal(
    PHASE3_DEFAULT_BACKEND,
    'local-cpu',
    'PHASE3_DEFAULT_BACKEND must be local-cpu after issue #105',
  )
})
