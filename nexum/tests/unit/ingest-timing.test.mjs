// Phase-1 dev-scout (issue #78): smoke test for src/ingest/timing.ts.
// Verifies the per-stage timing emitter records events for both success and
// failure paths and exposes a swappable sink for downstream consumers (#12).

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { timeStage, setStageSink, resetStageSink } = await import('../../dist/ingest/timing.js')

test('timeStage emits a StageEvent with ok=true on success', async () => {
  const events = []
  setStageSink((e) => events.push(e))
  try {
    const result = await timeStage('parse', { docId: 'doc-1', blockCount: 3 }, () => 42)
    assert.equal(result, 42)
    assert.equal(events.length, 1)
    assert.equal(events[0].nexum_ingest_stage, 'parse')
    assert.equal(events[0].doc_id, 'doc-1')
    assert.equal(events[0].block_count, 3)
    assert.equal(events[0].ok, true)
    assert.equal(typeof events[0].duration_ms, 'number')
    assert.equal(typeof events[0].ts, 'string')
  } finally {
    resetStageSink()
  }
})

test('timeStage emits ok=false and re-throws on failure', async () => {
  const events = []
  setStageSink((e) => events.push(e))
  try {
    await assert.rejects(
      () => timeStage('embed', { docId: 'doc-2' }, async () => { throw new Error('boom') }),
      /boom/,
    )
    assert.equal(events.length, 1)
    assert.equal(events[0].nexum_ingest_stage, 'embed')
    assert.equal(events[0].ok, false)
  } finally {
    resetStageSink()
  }
})
