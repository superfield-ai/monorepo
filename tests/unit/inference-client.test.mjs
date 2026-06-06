// Phase-2 dev-scout (issue #79): smoke test for src/inference/client.ts.
// Verifies the inference-client interface compiles, the stub is reachable,
// and every stub method rejects loudly so accidental real-path calls fail
// instead of returning fake numbers.

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { StubInferenceClient } = await import('../../dist/inference/client.js')

test('StubInferenceClient.embed rejects with a scout-stub message', async () => {
  const c = new StubInferenceClient()
  assert.equal(c.name, 'stub-inference-client')
  await assert.rejects(() => c.embed('hello'), /scout stub/i)
})

test('StubInferenceClient.retrieve rejects for every mode', async () => {
  const c = new StubInferenceClient()
  await assert.rejects(() => c.retrieve('q', 'vector'), /scout stub/i)
  await assert.rejects(() => c.retrieve('q', 'graph'), /scout stub/i)
  await assert.rejects(() => c.retrieve('q', 'hybrid'), /scout stub/i)
})

test('StubInferenceClient.score rejects with a scout-stub message', async () => {
  const c = new StubInferenceClient()
  await assert.rejects(
    () => c.score('q', [{ blockId: 'b1', score: 0.5 }]),
    /scout stub/i,
  )
})
