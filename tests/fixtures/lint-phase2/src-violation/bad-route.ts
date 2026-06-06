/**
 * Fixture: a route handler that imports @anthropic-ai/sdk directly.
 * This file is intentionally non-conformant; it exists to let the
 * lint-phase2-inference-client unit tests assert that the lint catches it.
 * It is never compiled or executed in production.
 *
 * Canonical reference: tests/unit/lint-phase2-inference-client.test.mjs
 */
import Anthropic from '@anthropic-ai/sdk'

export async function badRoute() {
  const client = new Anthropic()
  return client.messages.create({ model: 'claude-3-5-sonnet-20241022', max_tokens: 10, messages: [] })
}
