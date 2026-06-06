/**
 * Phase-3 (issue #108): Anthropic hosted-provider adapter.
 *
 * Opt-in only. Architecture constraint A4 keeps the local CPU model as the
 * default; this adapter exists so users with `ANTHROPIC_API_KEY` can swap to
 * Claude for `classifyLink` / `score` quality without changing call sites.
 *
 * ## Opt-in usage
 *
 * ```bash
 * NEXUM_INFERENCE_BACKEND=anthropic ANTHROPIC_API_KEY=sk-ant-… node …
 * ```
 *
 * The adapter reads its API key from `process.env.ANTHROPIC_API_KEY` at
 * construction time (or from the `apiKey` config field). If neither is
 * present, every method rejects with a clear error message — no silent
 * fallback to the local-CPU path.
 *
 * ## Method behaviour
 *
 * - **classifyLink**: sends `contentA` and `contentB` to the Messages API
 *   with a structured prompt asking for a relation label. Returns one of the
 *   SIGNALS labels (`supports | contradicts | elaborates | overrides |
 *   is-exception-to`) or `null`.
 * - **score**: uses the Messages API to rate each block's relevance to the
 *   query and returns normalised [0,1] scores.
 * - **embed**: Anthropic does not ship a first-party embedding endpoint;
 *   this method rejects with a clear explanation. Callers that need
 *   embeddings should use the local-CPU adapter or OpenAI.
 * - **retrieve**: requires database access; rejects with an explanatory error.
 *   The retrieval layer (issues #10/#14) owns this path.
 *
 * ## Tests
 *
 * Tests run without an API key by injecting a stub via
 * `injectAnthropicFetchForTest`. See the test seam functions below.
 *
 * Canonical references:
 *   - docs/architecture.md § A3 / A4 / OD4
 *   - docs/implementation-plan.md (Phase 3, issue #108)
 *   - src/inference/index.ts (backend selection via NEXUM_INFERENCE_BACKEND)
 */

import type {
  ClassifyLinkInput,
  EvidenceScore,
  InferenceClient,
  RetrievalMode,
  RetrievalResult,
  RetrievedBlock,
} from '../client.js'

// ---------------------------------------------------------------------------
// Relation labels (must match SIGNALS in src/linker/ai.ts)
// ---------------------------------------------------------------------------

const LINK_LABELS = [
  'supports',
  'contradicts',
  'elaborates',
  'overrides',
  'is-exception-to',
] as const

type LinkLabel = (typeof LINK_LABELS)[number]

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface AnthropicInferenceClientConfig {
  /** Anthropic API key. Falls back to `process.env.ANTHROPIC_API_KEY`. */
  apiKey?: string
  /**
   * Claude model to use for text generation tasks. Defaults to
   * `'claude-3-haiku-20240307'` (lowest latency / cost; swap for
   * `claude-3-5-sonnet-20241022` for higher quality).
   */
  model?: string
  /**
   * Base URL for the Anthropic API. Defaults to
   * `'https://api.anthropic.com'`. Override in tests to point at a local
   * stub server.
   */
  baseUrl?: string
}

// ---------------------------------------------------------------------------
// Test seam — module-level fetch override so tests can inject responses
// without a real API key.
// ---------------------------------------------------------------------------

type AnthropicFetch = (
  url: string,
  body: unknown,
  apiKey: string,
) => Promise<{ content: Array<{ type: string; text: string }> }>

let _fetchOverride: AnthropicFetch | null = null

/**
 * Replace the Anthropic API fetch with a test stub. Call
 * `resetAnthropicFetchForTest()` in a finally block.
 *
 * @example
 * ```ts
 * injectAnthropicFetchForTest(async (_url, _body, _key) => ({
 *   content: [{ type: 'text', text: 'supports' }],
 * }))
 * ```
 */
export function injectAnthropicFetchForTest(stub: AnthropicFetch): void {
  _fetchOverride = stub
}

/** Drop the injected stub, restoring real API calls. */
export function resetAnthropicFetchForTest(): void {
  _fetchOverride = null
}

// ---------------------------------------------------------------------------
// AnthropicInferenceClient
// ---------------------------------------------------------------------------

/**
 * Opt-in `InferenceClient` backed by the Anthropic Messages API.
 *
 * Select via `NEXUM_INFERENCE_BACKEND=anthropic`. Requires
 * `ANTHROPIC_API_KEY` (or `config.apiKey`) to be set before any method
 * that calls the API is invoked.
 */
export class AnthropicInferenceClient implements InferenceClient {
  readonly name = 'anthropic-inference-client'

  private readonly apiKey: string
  private readonly model: string
  private readonly baseUrl: string

  constructor(config: AnthropicInferenceClientConfig = {}) {
    this.apiKey = config.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? ''
    this.model = config.model ?? 'claude-3-haiku-20240307'
    this.baseUrl = config.baseUrl ?? 'https://api.anthropic.com'
  }

  // -------------------------------------------------------------------------
  // InferenceClient.embed — not supported by Anthropic
  // -------------------------------------------------------------------------

  /**
   * Anthropic does not provide a first-party text embedding endpoint.
   * Use the local-CPU adapter (`NEXUM_INFERENCE_BACKEND=local-cpu`) or
   * the OpenAI adapter (`NEXUM_INFERENCE_BACKEND=openai`) for embeddings.
   */
  embed(_text: string): Promise<number[]> {
    return Promise.reject(
      new Error(
        'AnthropicInferenceClient.embed(): Anthropic does not ship a ' +
          'first-party embedding endpoint. Use the local-CPU adapter ' +
          "(NEXUM_INFERENCE_BACKEND=local-cpu) or OpenAI adapter " +
          "(NEXUM_INFERENCE_BACKEND=openai) for embeddings.",
      ),
    )
  }

  // -------------------------------------------------------------------------
  // InferenceClient.retrieve — requires database access
  // -------------------------------------------------------------------------

  /**
   * Retrieval requires database access and is implemented by the retrieval
   * layer (issues #10/#14). This hosted-provider adapter does not implement
   * retrieval.
   */
  retrieve(_query: string, _mode: RetrievalMode): Promise<RetrievalResult> {
    return Promise.reject(
      new Error(
        'AnthropicInferenceClient.retrieve(): retrieval requires database ' +
          'access and is not implemented by the hosted-provider adapter. ' +
          'The retrieval layer (issues #10/#14) owns this path.',
      ),
    )
  }

  // -------------------------------------------------------------------------
  // InferenceClient.score
  // -------------------------------------------------------------------------

  /**
   * Score each evidence block's relevance to `query` using the Claude API.
   *
   * Sends a single prompt listing all blocks and asks Claude to rate each
   * on a 0–10 scale. Scores are normalised to [0, 1]. Order of returned
   * scores matches the input order.
   *
   * Requires `ANTHROPIC_API_KEY` (or `config.apiKey`).
   */
  async score(query: string, evidence: RetrievedBlock[]): Promise<EvidenceScore[]> {
    this._assertApiKey('score')
    if (evidence.length === 0) return []

    const blockList = evidence
      .map((b, i) => `Block ${i} (id=${b.blockId}): ${(b.text ?? '').slice(0, 300)}`)
      .join('\n')

    const prompt =
      `Rate how relevant each block is to the query on a scale of 0 to 10.\n` +
      `Query: ${query.slice(0, 500)}\n\n${blockList}\n\n` +
      `Reply with exactly one line per block in the format: ` +
      `"Block <index>: <score>" where <score> is an integer 0-10.`

    const responseText = await this._callMessages(prompt)

    // Parse "Block 0: 8\nBlock 1: 3\n..."
    const scores: EvidenceScore[] = evidence.map((block, i) => {
      const match = responseText.match(new RegExp(`Block\\s+${i}\\s*:\\s*(\\d+)`))
      const raw = match ? parseInt(match[1], 10) : 5
      return { blockId: block.blockId, score: Math.min(10, Math.max(0, raw)) / 10 }
    })
    return scores
  }

  // -------------------------------------------------------------------------
  // InferenceClient.classifyLink
  // -------------------------------------------------------------------------

  /**
   * Classify the relation between two candidate blocks using the Claude API.
   *
   * Returns one of the SIGNALS labels (`supports | contradicts | elaborates |
   * overrides | is-exception-to`) or `null` when no link should be produced.
   *
   * Fast-path: returns `null` immediately when `cosineSim < 0.70` (same
   * threshold as the heuristic linker in `src/linker/ai.ts`).
   *
   * Requires `ANTHROPIC_API_KEY` (or `config.apiKey`).
   */
  async classifyLink(input: ClassifyLinkInput): Promise<string | null> {
    // Fast-path cosine bypass — mirrors the heuristic linker threshold.
    if (input.cosineSim < 0.70) return null

    this._assertApiKey('classifyLink')

    const labelList = LINK_LABELS.join(' | ')
    const prompt =
      `Classify the relationship between Block A and Block B.\n\n` +
      `Block A: ${input.contentA.slice(0, 400)}\n\n` +
      `Block B: ${input.contentB.slice(0, 400)}\n\n` +
      `Choose exactly one label from: ${labelList}\n` +
      `If no meaningful relationship exists, reply with: none\n` +
      `Reply with only the label, nothing else.`

    const responseText = await this._callMessages(prompt)
    const trimmed = responseText.trim().toLowerCase()

    if ((LINK_LABELS as ReadonlyArray<string>).includes(trimmed)) {
      return trimmed as LinkLabel
    }
    return null
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _assertApiKey(method: string): void {
    if (!this.apiKey) {
      throw new Error(
        `AnthropicInferenceClient.${method}(): ANTHROPIC_API_KEY is not set. ` +
          `Set the env var or pass apiKey in the config to use the Anthropic adapter.`,
      )
    }
  }

  /**
   * Call the Anthropic Messages API with a single-user message. Returns the
   * text content of the first content block.
   */
  private async _callMessages(userPrompt: string): Promise<string> {
    const url = `${this.baseUrl}/v1/messages`
    const body = {
      model: this.model,
      max_tokens: 256,
      messages: [{ role: 'user', content: userPrompt }],
    }

    const response = _fetchOverride
      ? await _fetchOverride(url, body, this.apiKey)
      : await this._httpPost(url, body)

    const firstBlock = response.content.find((b) => b.type === 'text')
    if (!firstBlock) {
      throw new Error(
        `AnthropicInferenceClient: unexpected response shape — no text block. ` +
          `Check the model and API version.`,
      )
    }
    return firstBlock.text
  }

  private async _httpPost(
    url: string,
    body: unknown,
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(
        `AnthropicInferenceClient: HTTP ${resp.status} from Anthropic API: ${text.slice(0, 200)}`,
      )
    }
    return (await resp.json()) as { content: Array<{ type: string; text: string }> }
  }
}
