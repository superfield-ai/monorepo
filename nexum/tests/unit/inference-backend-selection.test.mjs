/**
 * Integration test: backend selection (issue #108).
 *
 * Verifies that `getDefaultInferenceClient()` selects `LocalCpuInferenceClient`
 * when `NEXUM_INFERENCE_BACKEND` is unset, and that the hosted-provider
 * adapters are selected correctly when the env var is set.
 *
 * Tests run WITHOUT a real API key (no model weights needed either — we only
 * check the `name` property of the selected client, not call any inference
 * methods).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  getDefaultInferenceClient,
  resetDefaultInferenceClient,
  PHASE3_DEFAULT_BACKEND,
} = await import('../../dist/inference/index.js')

test('PHASE3_DEFAULT_BACKEND is local-cpu', () => {
  assert.equal(PHASE3_DEFAULT_BACKEND, 'local-cpu')
})

test('with NEXUM_INFERENCE_BACKEND unset, default client is LocalCpuInferenceClient', () => {
  delete process.env['NEXUM_INFERENCE_BACKEND']
  resetDefaultInferenceClient()
  const client = getDefaultInferenceClient()
  assert.equal(client.name, 'local-cpu-inference-client')
  resetDefaultInferenceClient()
})

test('with NEXUM_INFERENCE_BACKEND=local-cpu, default client is LocalCpuInferenceClient', () => {
  process.env['NEXUM_INFERENCE_BACKEND'] = 'local-cpu'
  resetDefaultInferenceClient()
  const client = getDefaultInferenceClient()
  assert.equal(client.name, 'local-cpu-inference-client')
  resetDefaultInferenceClient()
  delete process.env['NEXUM_INFERENCE_BACKEND']
})

test('with NEXUM_INFERENCE_BACKEND=stub, default client is StubInferenceClient', () => {
  process.env['NEXUM_INFERENCE_BACKEND'] = 'stub'
  resetDefaultInferenceClient()
  const client = getDefaultInferenceClient()
  assert.equal(client.name, 'stub-inference-client')
  resetDefaultInferenceClient()
  delete process.env['NEXUM_INFERENCE_BACKEND']
})

test('with NEXUM_INFERENCE_BACKEND=anthropic, default client is AnthropicInferenceClient', () => {
  process.env['NEXUM_INFERENCE_BACKEND'] = 'anthropic'
  resetDefaultInferenceClient()
  const client = getDefaultInferenceClient()
  assert.equal(client.name, 'anthropic-inference-client')
  resetDefaultInferenceClient()
  delete process.env['NEXUM_INFERENCE_BACKEND']
})

test('with NEXUM_INFERENCE_BACKEND=openai, default client is OpenAiInferenceClient', () => {
  process.env['NEXUM_INFERENCE_BACKEND'] = 'openai'
  resetDefaultInferenceClient()
  const client = getDefaultInferenceClient()
  assert.equal(client.name, 'openai-inference-client')
  resetDefaultInferenceClient()
  delete process.env['NEXUM_INFERENCE_BACKEND']
})

test('with unknown NEXUM_INFERENCE_BACKEND, falls back to local-cpu', () => {
  process.env['NEXUM_INFERENCE_BACKEND'] = 'unknown-backend'
  resetDefaultInferenceClient()
  const client = getDefaultInferenceClient()
  assert.equal(client.name, 'local-cpu-inference-client')
  resetDefaultInferenceClient()
  delete process.env['NEXUM_INFERENCE_BACKEND']
})
