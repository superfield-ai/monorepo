// Phase-1 dev-scout (issue #78): smoke test for src/eval/harness.ts.
// Verifies the QA scorer interface is reachable, the null scorer returns the
// stub shape, and aggregation handles all-null and mixed-numeric inputs.

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { NullQAScorer, CitationOverlapScorer, aggregate } = await import('../../dist/eval/harness.js')

test('NullQAScorer returns null dimensions', async () => {
  const s = new NullQAScorer()
  const score = await s.score(
    { id: 'q1', question: 'q', goldAnswer: 'a' },
    { exampleId: 'q1', predictedAnswer: 'a', retrievedBlockIds: [], latencyMs: 0 },
  )
  assert.equal(score.exampleId, 'q1')
  assert.equal(score.exactMatch, null)
  assert.equal(score.f1, null)
  assert.equal(score.citationPrecision, null)
  assert.equal(score.citationRecall, null)
})

test('aggregate returns null means when all scores are null', () => {
  const report = aggregate('vanilla-rag', 'null-scorer', [
    { exampleId: 'a', exactMatch: null, f1: null, citationPrecision: null, citationRecall: null },
    { exampleId: 'b', exactMatch: null, f1: null, citationPrecision: null, citationRecall: null },
  ])
  assert.equal(report.mode, 'vanilla-rag')
  assert.equal(report.scorerName, 'null-scorer')
  assert.equal(report.exampleCount, 2)
  assert.equal(report.meanExactMatch, null)
  assert.equal(report.meanF1, null)
})

test('CitationOverlapScorer scores precision/recall/F1 vs gold block set', () => {
  const scorer = new CitationOverlapScorer()
  // gold = {b1, b2}; retrieved = [b1, b3, b4] → hits=1 → P=1/3, R=1/2, F1=0.4
  const score = scorer.score(
    { id: 'q1', question: 'q', goldAnswer: 'a', goldBlockIds: ['b1', 'b2'] },
    { exampleId: 'q1', predictedAnswer: '', retrievedBlockIds: ['b1', 'b3', 'b4'], latencyMs: 0 },
  )
  assert.equal(score.exactMatch, null)
  assert.ok(Math.abs(score.citationPrecision - 1 / 3) < 1e-9)
  assert.ok(Math.abs(score.citationRecall - 1 / 2) < 1e-9)
  assert.ok(Math.abs(score.f1 - 0.4) < 1e-9)
})

test('CitationOverlapScorer null when both gold and retrieved are empty', () => {
  const scorer = new CitationOverlapScorer()
  const score = scorer.score(
    { id: 'q', question: 'q', goldAnswer: 'a' },
    { exampleId: 'q', predictedAnswer: '', retrievedBlockIds: [], latencyMs: 0 },
  )
  assert.equal(score.f1, null)
  assert.equal(score.citationPrecision, null)
})

test('aggregate computes means over numeric scores only', () => {
  const report = aggregate('nexum', 'em-scorer', [
    { exampleId: 'a', exactMatch: 1, f1: 1, citationPrecision: 0.5, citationRecall: 1 },
    { exampleId: 'b', exactMatch: 0, f1: 0.5, citationPrecision: null, citationRecall: 0 },
  ])
  assert.equal(report.exampleCount, 2)
  assert.equal(report.meanExactMatch, 0.5)
  assert.equal(report.meanF1, 0.75)
  assert.equal(report.meanCitationPrecision, 0.5)
  assert.equal(report.meanCitationRecall, 0.5)
})
