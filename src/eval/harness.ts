/**
 * Phase-1 dev-scout (issue #78): QA evaluation harness scaffold.
 *
 * This module defines the typed seam shared by:
 *   - #9  (G2 wedge: vanilla-RAG vs Nexum on QA accuracy)
 *   - #11 (Area 4: provenance evaluation)
 *
 * It intentionally contains NO real evaluation logic. The runnable scorers,
 * dataset loaders, and report writers land in the downstream issues; this
 * file only fixes the interface so that those issues can be developed in
 * parallel and rendezvous on a common type surface.
 *
 * Canonical references:
 *   - docs/research.md (Area 4: Provenance, G2 wedge)
 *   - docs/engineering.md (Phase-1 Scout Seams)
 */

/**
 * A single QA example. `goldAnswer` is the canonical reference answer.
 * `goldBlockIds` are the block UUIDs that an ideal retriever would surface
 * (used by provenance / faithfulness scoring in #11).
 */
export interface QAExample {
  id: string
  question: string
  goldAnswer: string
  goldBlockIds?: string[]
  meta?: Record<string, unknown>
}

/**
 * The output of a single mode (vanilla-RAG or Nexum) for one example.
 * `retrievedBlockIds` are the blocks the system surfaced, in rank order.
 */
export interface QAPrediction {
  exampleId: string
  predictedAnswer: string
  retrievedBlockIds: string[]
  latencyMs: number
  meta?: Record<string, unknown>
}

/**
 * Per-example scoring breakdown. Numeric fields are in [0, 1]; null means the
 * scorer chose not to compute that dimension for this example.
 */
export interface QAScore {
  exampleId: string
  exactMatch: number | null
  f1: number | null
  /** Provenance: fraction of retrievedBlockIds that are in goldBlockIds. */
  citationPrecision: number | null
  /** Provenance: fraction of goldBlockIds that appear in retrievedBlockIds. */
  citationRecall: number | null
  meta?: Record<string, unknown>
}

/**
 * The mode under test. The scout fixes only the discriminator strings; #9 and
 * #11 are responsible for wiring concrete pipelines behind each mode.
 */
export type QAMode = 'vanilla-rag' | 'nexum'

/**
 * The pluggable scorer interface. Implementations are added by #11.
 *
 * Implementors should be PURE with respect to the database — all I/O happens
 * in the runner that produces `QAPrediction`s. The scorer takes example +
 * prediction and returns a score.
 */
export interface QAScorer {
  readonly name: string
  score(example: QAExample, prediction: QAPrediction): Promise<QAScore> | QAScore
}

/**
 * Aggregate report shape. Persisted by the runner; consumed by experiment
 * results writers (`experiments/_lib/results_writer.py`).
 */
export interface QAReport {
  mode: QAMode
  scorerName: string
  exampleCount: number
  meanExactMatch: number | null
  meanF1: number | null
  meanCitationPrecision: number | null
  meanCitationRecall: number | null
  generatedAt: string
}

/**
 * Stub scorer used only to verify the harness compiles and the type surface
 * is reachable from tests. It does not implement real EM/F1; it returns null
 * for every dimension. #11 replaces this with `ExactMatchScorer`,
 * `TokenF1Scorer`, and `CitationOverlapScorer`.
 */
export class NullQAScorer implements QAScorer {
  readonly name = 'null-scorer'
  score(example: QAExample, prediction: QAPrediction): QAScore {
    return {
      exampleId: example.id,
      exactMatch: null,
      f1: null,
      citationPrecision: null,
      citationRecall: null,
    }
  }
}

/**
 * Citation-overlap scorer used by the G2 wedge (issue #9).
 *
 * Compares the retrieved block-id list against the gold block-id set:
 *   - citationPrecision = |retrieved ∩ gold| / |retrieved|
 *   - citationRecall    = |retrieved ∩ gold| / |gold|
 *   - f1                = harmonic mean of the two
 *
 * Exact/F1 over the predicted answer string are not computed here; the G2
 * wedge runs in retrieval-only mode (no LLM generation), so token-level QA
 * scores would be misleading. Issue #11 will add `TokenF1Scorer` and
 * `ExactMatchScorer` once the answer-generation path is wired.
 */
export class CitationOverlapScorer implements QAScorer {
  readonly name = 'citation-overlap'
  score(example: QAExample, prediction: QAPrediction): QAScore {
    const gold = new Set(example.goldBlockIds ?? [])
    const retrieved = prediction.retrievedBlockIds
    if (gold.size === 0 && retrieved.length === 0) {
      return {
        exampleId: example.id,
        exactMatch: null,
        f1: null,
        citationPrecision: null,
        citationRecall: null,
      }
    }
    let hits = 0
    for (const id of retrieved) if (gold.has(id)) hits++
    const precision = retrieved.length === 0 ? 0 : hits / retrieved.length
    const recall = gold.size === 0 ? 0 : hits / gold.size
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
    return {
      exampleId: example.id,
      exactMatch: null,
      f1,
      citationPrecision: precision,
      citationRecall: recall,
    }
  }
}

/**
 * Aggregate a stream of per-example scores into a report. Defined here so the
 * shape is stable across #9 and #11.
 */
export function aggregate(
  mode: QAMode,
  scorerName: string,
  scores: QAScore[],
): QAReport {
  const mean = (key: keyof QAScore): number | null => {
    const values = scores
      .map(s => s[key])
      .filter((v): v is number => typeof v === 'number')
    if (values.length === 0) return null
    return values.reduce((a, b) => a + b, 0) / values.length
  }
  return {
    mode,
    scorerName,
    exampleCount: scores.length,
    meanExactMatch: mean('exactMatch'),
    meanF1: mean('f1'),
    meanCitationPrecision: mean('citationPrecision'),
    meanCitationRecall: mean('citationRecall'),
    generatedAt: new Date().toISOString(),
  }
}
