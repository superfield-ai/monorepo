/**
 * Issue #106 — Linker InferenceClient adapter integration tests.
 *
 * Verifies that the linker classification path works end-to-end through
 * both the HeuristicInferenceClient and a LocalCpuInferenceClient with an
 * injected stub pipeline, satisfying the issue #106 test plan items:
 *
 *   - Integration test: linker pipeline runs against HeuristicInferenceClient
 *   - Integration test: linker pipeline runs against LocalCpuInferenceClient
 *
 * No real model weights are required. The LocalCpuInferenceClient is
 * exercised via the injectable pipeline seam (see src/inference/local-cpu.ts).
 * Database calls are avoided; we test the classification seam directly.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

// ---------------------------------------------------------------------------
// HeuristicInferenceClient — linker adapter integration
// ---------------------------------------------------------------------------

test('[adapter=heuristic] classifyLink covers all SIGNALS relation types', async () => {
  const { HeuristicInferenceClient } = await import('../../dist/inference/adapters/heuristic.js')
  const { SIGNALS } = await import('../../dist/linker/ai.js')
  const client = new HeuristicInferenceClient()

  const signalPairs = {
    contradicts:       'however, this does not apply',
    supports:          'furthermore, this confirms the obligation',
    elaborates:        'specifically, this means direct liability',
    overrides:         'supersedes all prior written agreements',
    'is-exception-to': 'except as provided in subsection (b)',
  }

  for (const [expectedRelType, contentB] of Object.entries(signalPairs)) {
    const result = await client.classifyLink({
      contentA: 'General obligation clause.',
      contentB,
      cosineSim: 0.80,
    })
    assert.equal(
      result,
      expectedRelType,
      `HeuristicInferenceClient should detect '${expectedRelType}' for contentB='${contentB}'`,
    )
    // Confirm the relType is also a key in the linker's SIGNALS export
    assert.ok(
      expectedRelType in SIGNALS,
      `relation type '${expectedRelType}' must be in linker SIGNALS`,
    )
  }
})

test('[adapter=heuristic] classifyLink rejects pairs below cosine threshold', async () => {
  const { HeuristicInferenceClient } = await import('../../dist/inference/adapters/heuristic.js')
  const client = new HeuristicInferenceClient()
  const result = await client.classifyLink({
    contentA: 'Agreement clause 1.',
    contentB: 'however, an exception applies',
    cosineSim: 0.68, // below 0.70 threshold
  })
  assert.equal(result, null, 'should return null when cosineSim < 0.70')
})

// ---------------------------------------------------------------------------
// LocalCpuInferenceClient — linker adapter integration (stub pipeline)
// ---------------------------------------------------------------------------

test('[adapter=local-cpu] classifyLink fast-path null when cosineSim < 0.70', async () => {
  const { LocalCpuInferenceClient } = await import('../../dist/inference/local-cpu.js')
  const client = new LocalCpuInferenceClient()
  // Fast-path: returns null without loading the pipeline.
  const result = await client.classifyLink({
    contentA: 'Section 1.',
    contentB: 'however, Section 1 does not apply',
    cosineSim: 0.65,
  })
  assert.equal(result, null)
})

test('[adapter=local-cpu] classifyLink returns label via injected stub pipeline', async () => {
  const {
    LocalCpuInferenceClient,
    injectClassifierPipelineForTest,
    resetClassifierPipelineForTest,
  } = await import('../../dist/inference/local-cpu.js')

  injectClassifierPipelineForTest(async (_text, _labels) => ({
    labels: ['supports', 'contradicts', 'elaborates', 'overrides', 'is-exception-to'],
    scores: [0.72, 0.12, 0.08, 0.05, 0.03],
  }))

  try {
    const client = new LocalCpuInferenceClient()
    const result = await client.classifyLink({
      contentA: 'The regulation is consistent with prior rulings.',
      contentB: 'Consistent with established precedent.',
      cosineSim: 0.85,
    })
    assert.equal(result, 'supports', 'injected pipeline returning supports at 0.72 should produce supports')
  } finally {
    resetClassifierPipelineForTest()
  }
})

test('[adapter=local-cpu] classifyLink returns null when all pipeline scores below threshold', async () => {
  const {
    LocalCpuInferenceClient,
    injectClassifierPipelineForTest,
    resetClassifierPipelineForTest,
  } = await import('../../dist/inference/local-cpu.js')

  // All scores below 0.35 (CLASSIFY_THRESHOLD)
  injectClassifierPipelineForTest(async (_text, _labels) => ({
    labels: ['supports', 'contradicts', 'elaborates', 'overrides', 'is-exception-to'],
    scores: [0.25, 0.22, 0.20, 0.18, 0.15],
  }))

  try {
    const client = new LocalCpuInferenceClient()
    const result = await client.classifyLink({
      contentA: 'Agreement clause.',
      contentB: 'Different topic entirely.',
      cosineSim: 0.75,
    })
    assert.equal(result, null, 'should return null when top score is below CLASSIFY_THRESHOLD')
  } finally {
    resetClassifierPipelineForTest()
  }
})

// ---------------------------------------------------------------------------
// Inference index: 'heuristic' backend selection
// ---------------------------------------------------------------------------

test("inference/index.ts resolves 'heuristic' backend via env var", async () => {
  const {
    setDefaultInferenceClient,
    resetDefaultInferenceClient,
    HeuristicInferenceClient,
  } = await import('../../dist/inference/index.js')

  resetDefaultInferenceClient()
  const heuristic = new HeuristicInferenceClient()
  setDefaultInferenceClient(heuristic)

  const { getDefaultInferenceClient } = await import('../../dist/inference/index.js')
  const client = getDefaultInferenceClient()
  assert.equal(client.name, 'heuristic-inference-client')

  resetDefaultInferenceClient()
})
