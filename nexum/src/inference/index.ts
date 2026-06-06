/**
 * Phase-3 inference default (issues #114, #105).
 *
 * Call sites that want "the inference client" go through
 * `getDefaultInferenceClient()` rather than `new`-ing a concrete class.
 *
 * Selection contract:
 *
 *   - The factory is memoised; the first call wins for the lifetime of the
 *     process. Tests that want a different client MUST call
 *     `setDefaultInferenceClient()` before any code path that resolves the
 *     default, or `resetDefaultInferenceClient()` between cases.
 *   - The factory consults `process.env.NEXUM_INFERENCE_BACKEND`:
 *       * `'local-cpu'`  (default, issue #105) — returns
 *         `LocalCpuInferenceClient` backed by `Xenova/nli-deberta-v3-xsmall`
 *         ONNX int8. Run `npm run fetch-model` to warm the cache.
 *       * `'stub'`       — returns `StubInferenceClient`. Useful in tests
 *         that do not need real inference and set this env var explicitly.
 *       * `'anthropic'` / `'openai'` — opt-in hosted-provider adapters.
 *         The adapter classes exist as throwing stubs in
 *         `src/inference/adapters/` and are filled in by issue #108.
 *   - Unknown values fall back to the local-cpu default and log once on
 *     stderr.
 *
 * Canonical references:
 *   - docs/architecture.md § A4 / OD1
 *   - docs/implementation-plan.md (Phase 3, issues #114 / #105)
 *   - models/manifest.json (pinned model identity and checksums)
 */

import { StubInferenceClient, type InferenceClient } from './client.js'
import { LocalCpuInferenceClient } from './local-cpu.js'
import { AnthropicInferenceClient } from './adapters/anthropic.js'
import { OpenAiInferenceClient } from './adapters/openai.js'
import { HeuristicInferenceClient } from './adapters/heuristic.js'

export type InferenceBackend = 'stub' | 'local-cpu' | 'anthropic' | 'openai' | 'heuristic'

/**
 * Phase-3 default (issue #105): `'local-cpu'` — `getDefaultInferenceClient()`
 * returns `LocalCpuInferenceClient` backed by `Xenova/nli-deberta-v3-xsmall`
 * ONNX int8 (pinned in `models/manifest.json`). Run `npm run fetch-model`
 * to warm the weight cache before first use.
 *
 * Prior to issue #105 this was `'stub'`; `StubInferenceClient` remains
 * available via `NEXUM_INFERENCE_BACKEND=stub` for tests that need a no-op
 * client.
 */
export const PHASE3_DEFAULT_BACKEND: InferenceBackend = 'local-cpu'

let cached: InferenceClient | null = null
let warnedUnknown = false

function selectBackend(): InferenceBackend {
  const raw = process.env.NEXUM_INFERENCE_BACKEND
  if (!raw) return PHASE3_DEFAULT_BACKEND
  if (raw === 'stub' || raw === 'local-cpu' || raw === 'anthropic' || raw === 'openai' || raw === 'heuristic') {
    return raw
  }
  if (!warnedUnknown) {
    warnedUnknown = true
    console.error(
      `[inference] unknown NEXUM_INFERENCE_BACKEND='${raw}', falling back to ` +
        `'${PHASE3_DEFAULT_BACKEND}' (see src/inference/index.ts).`,
    )
  }
  return PHASE3_DEFAULT_BACKEND
}

function construct(backend: InferenceBackend): InferenceClient {
  switch (backend) {
    case 'stub':
      return new StubInferenceClient()
    case 'local-cpu':
      return new LocalCpuInferenceClient()
    case 'anthropic':
      return new AnthropicInferenceClient()
    case 'openai':
      return new OpenAiInferenceClient()
    case 'heuristic':
      return new HeuristicInferenceClient()
  }
}

/**
 * Phase-3 (issue #106): construct the default backend with automatic fallback
 * to `HeuristicInferenceClient` when the local CPU model fails to load.
 *
 * The local-cpu backend downloads ONNX weights on first use; in environments
 * where the model cache is absent or OOM prevents loading, the linker must
 * still function. The heuristic adapter provides keyword-based classification
 * as a zero-dependency fallback.
 *
 * Fallback only activates for the `'local-cpu'` backend; `'stub'`, `'anthropic'`,
 * and `'openai'` are returned as-is (they manage their own error handling).
 */
function constructWithFallback(backend: InferenceBackend): InferenceClient {
  const client = construct(backend)
  if (backend !== 'local-cpu') return client

  // Wrap LocalCpuInferenceClient with a classifyLink proxy that falls back
  // to HeuristicInferenceClient on the first model-load failure.
  const heuristic = new HeuristicInferenceClient()
  let fallbackActive = false

  return new Proxy(client, {
    get(target, prop) {
      if (prop !== 'classifyLink') return (target as any)[prop]
      return async (input: Parameters<InferenceClient['classifyLink']>[0]) => {
        if (fallbackActive) {
          return heuristic.classifyLink(input)
        }
        try {
          return await (target as LocalCpuInferenceClient).classifyLink(input)
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          // Activate fallback permanently on model-load errors.
          if (
            msg.includes('Could not locate') ||
            msg.includes('ONNX') ||
            msg.includes('Failed to fetch') ||
            msg.includes('ENOENT') ||
            msg.includes('fetch-model')
          ) {
            if (!fallbackActive) {
              fallbackActive = true
              console.error(
                '[inference] local-cpu model unavailable; falling back to heuristic classifier. ' +
                  'Run `npm run fetch-model` to warm the model cache.',
              )
            }
            return heuristic.classifyLink(input)
          }
          throw err
        }
      }
    },
  })
}

/**
 * Return the process-wide default `InferenceClient`. Memoised after the
 * first call. See module header for the selection contract.
 */
export function getDefaultInferenceClient(): InferenceClient {
  if (cached) return cached
  cached = constructWithFallback(selectBackend())
  return cached
}

/**
 * Override the default for tests or for callers that want to inject a custom
 * client (e.g. a recording double). Subsequent calls to
 * `getDefaultInferenceClient()` return `client` until `reset` is invoked.
 */
export function setDefaultInferenceClient(client: InferenceClient): void {
  cached = client
}

/** Drop the memoised default so the next `getDefaultInferenceClient()` re-selects. */
export function resetDefaultInferenceClient(): void {
  cached = null
  warnedUnknown = false
}

export { LocalCpuInferenceClient } from './local-cpu.js'
export { AnthropicInferenceClient } from './adapters/anthropic.js'
export { OpenAiInferenceClient } from './adapters/openai.js'
export { HeuristicInferenceClient, heuristicClassifyPair } from './adapters/heuristic.js'
export type {
  ClassifyLinkInput,
  EvidenceScore,
  InferenceClient,
  RetrievalMode,
  RetrievalResult,
  RetrievedBlock,
} from './client.js'
export { StubInferenceClient } from './client.js'
