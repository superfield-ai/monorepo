/**
 * Fixture: an adapter file that imports @anthropic-ai/sdk.
 * This file lives under src/inference/adapters/ (mirrored in the fixture tree)
 * and must be allowed by the lint — adapters are the sanctioned seam.
 *
 * Canonical reference: tests/unit/lint-phase2-inference-client.test.mjs
 */
import Anthropic from '@anthropic-ai/sdk'

export class FixtureAnthropicAdapter {
  private client = new Anthropic()
  async embed(_text: string): Promise<number[]> { return [] }
}
