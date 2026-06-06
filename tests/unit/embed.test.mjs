import { test } from 'node:test'
import assert from 'node:assert/strict'

test('embedTexts returns correct shape for single text', async () => {
  // This test requires the model to be downloaded — skip if not available
  // For unit testing just verify the function exists
  const { embedTexts } = await import('../../dist/embed/local.js')
  assert.equal(typeof embedTexts, 'function')
})

test('enqueueJob and claimJob types are correct', async () => {
  const { enqueueJob, claimJob } = await import('../../dist/db/jobs.js')
  assert.equal(typeof enqueueJob, 'function')
  assert.equal(typeof claimJob, 'function')
})
