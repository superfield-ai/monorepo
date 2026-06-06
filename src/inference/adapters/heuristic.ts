/**
 * Phase-3 (issue #106): HeuristicInferenceClient — keyword-heuristic fallback adapter.
 *
 * Implements `InferenceClient.classifyLink` using the prior keyword-heuristic
 * logic from `src/linker/ai.ts` (the `classifyPair` function). Selected
 * automatically when the local CPU model fails to load, so the linker pipeline
 * always has a working implementation.
 *
 * Canonical references:
 *   - docs/architecture.md § A3 / A4
 *   - docs/implementation-plan.md (Phase 3, issue #106)
 *   - src/linker/ai.ts (original SIGNALS table)
 */

import type {
  ClassifyLinkInput,
  EvidenceScore,
  InferenceClient,
  RetrievalMode,
  RetrievalResult,
  RetrievedBlock,
} from '../client.js'

/**
 * Keyword signal table — mirrors SIGNALS in `src/linker/ai.ts`.
 * Kept private to the adapter so changes here do not break the linker's
 * exported constant and vice-versa.
 */
const HEURISTIC_SIGNALS: Record<string, string[]> = {
  contradicts:      ['not ', 'however', 'contrary', 'but ', 'instead', 'unlike', 'disagrees', 'conflicts'],
  supports:         ['similarly', 'also ', 'furthermore', 'consistent', 'confirms', 'in accordance', 'agrees'],
  elaborates:       ['specifically', 'for example', 'in particular', 'namely', 'that is', 'i.e.', 'e.g.'],
  overrides:        ['supersedes', 'replaces', 'amends', 'notwithstanding', 'prevails over', 'controls over'],
  'is-exception-to': ['except', 'unless', 'provided that', 'subject to', 'other than', 'excluding'],
}

/**
 * Classify a block pair using keyword heuristics.
 *
 * This is the original `classifyPair` logic extracted from `src/linker/ai.ts`
 * and wrapped behind the `InferenceClient` interface. It provides a
 * zero-dependency, always-available fallback classification path.
 *
 * @param contentA - Content of the source block.
 * @param contentB - Content of the target block.
 * @param cosineSim - Pre-computed cosine similarity score.
 * @returns Relation type label, or `null` if no link should be produced.
 */
export function heuristicClassifyPair(
  contentA: string,
  contentB: string,
  cosineSim: number,
): string | null {
  if (cosineSim < 0.70) return null
  const b = contentB.toLowerCase()
  for (const [relType, keywords] of Object.entries(HEURISTIC_SIGNALS)) {
    if (keywords.some(kw => b.includes(kw))) return relType
  }
  return cosineSim > 0.85 ? 'supports' : null
}

/**
 * Keyword-heuristic `InferenceClient` adapter.
 *
 * Wraps `heuristicClassifyPair` behind the `InferenceClient` interface.
 * All methods except `classifyLink` reject — the heuristic adapter is
 * classification-only; embedding and retrieval stay in the local-CPU or
 * hosted-provider adapters.
 *
 * Auto-selected by `getDefaultInferenceClient()` when the local CPU model
 * fails to load (e.g. weights not cached, OOM). Requires no API keys and no
 * network access.
 */
export class HeuristicInferenceClient implements InferenceClient {
  readonly name = 'heuristic-inference-client'

  embed(_text: string): Promise<number[]> {
    return Promise.reject(
      new Error(
        'HeuristicInferenceClient.embed() is not implemented; ' +
          'embedding requires a real model backend (local-cpu or hosted provider).',
      ),
    )
  }

  retrieve(_query: string, _mode: RetrievalMode): Promise<RetrievalResult> {
    return Promise.reject(
      new Error(
        'HeuristicInferenceClient.retrieve() is not implemented; ' +
          'retrieval requires a real model backend (local-cpu or hosted provider).',
      ),
    )
  }

  score(_query: string, _evidence: RetrievedBlock[]): Promise<EvidenceScore[]> {
    return Promise.reject(
      new Error(
        'HeuristicInferenceClient.score() is not implemented; ' +
          'scoring requires a real model backend (local-cpu or hosted provider).',
      ),
    )
  }

  /**
   * Classify the relation between two candidate blocks using keyword heuristics.
   * Always succeeds without any model weights or network access.
   */
  classifyLink(input: ClassifyLinkInput): Promise<string | null> {
    return Promise.resolve(
      heuristicClassifyPair(input.contentA, input.contentB, input.cosineSim),
    )
  }
}
