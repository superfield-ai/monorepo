import type { AgentOpts, AgentResult } from '../../agent.ts';

/**
 * Layer 1 helper: build a canned `AgentResult` for tests that inject a fake
 * spawn into `runLLMTask`, `tickDevLoop`, etc.
 *
 * See `docs/testing.md` §Layer 1.
 */
export interface FakeAgentResultInput {
  output: string;
  sessionId?: string;
  isError?: boolean;
  costUsd?: number;
}

let counter = 0;

export function makeAgentResult(input: FakeAgentResultInput): AgentResult {
  counter++;
  return {
    sessionId: input.sessionId ?? `test-sess-${counter}`,
    output: input.output,
    isError: input.isError ?? false,
    costUsd: input.costUsd,
  };
}

/**
 * Returns a spawn function that returns canned `AgentResult` values on each
 * call. Pass a single object for one response, or an array to rotate through
 * a sequence (the last entry repeats once exhausted).
 */
export function fakeSpawn(
  responses: FakeAgentResultInput | FakeAgentResultInput[],
): (opts: AgentOpts) => Promise<AgentResult> {
  const list = Array.isArray(responses) ? responses : [responses];
  let idx = 0;
  return async (_opts: AgentOpts) => {
    const next = list[idx] ?? list[list.length - 1]!;
    idx++;
    return makeAgentResult(next);
  };
}
