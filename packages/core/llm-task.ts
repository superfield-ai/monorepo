import { spawnAgent, type AgentOpts, type AgentResult } from './agent.ts';

/**
 * Wraps `spawnAgent` for one-shot LLM tasks that emit structured JSON.
 * Used by planning loop steps, doc loop steps, and one-shot commands
 * (`plan`, `feature`).
 *
 * The `parse` function is responsible for validating the JSON shape.
 * Throw inside `parse` if the response is malformed.
 */
export interface LLMTaskOpts {
  /** The prompt to send. Built via one of the prompt builders. */
  prompt: string;
  /** Working directory for the spawned `claude` process. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Optional session ID to resume. */
  sessionId?: string;
  /** Override max turns (default: 10 for one-shot tasks — much less than dev agents). */
  maxTurns?: number;
  /** Injectable spawn function for testing. */
  spawn?: (opts: AgentOpts) => Promise<AgentResult>;
}

export interface LLMTaskResult<T> {
  result: T;
  sessionId: string;
  costUsd?: number;
}

export async function runLLMTask<T>(
  opts: LLMTaskOpts,
  parse: (jsonText: string) => T,
): Promise<LLMTaskResult<T>> {
  const spawn = opts.spawn ?? spawnAgent;
  const res = await spawn({
    prompt: opts.prompt,
    worktreePath: opts.cwd ?? process.cwd(),
    sessionId: opts.sessionId,
    maxTurns: opts.maxTurns ?? 10,
  });

  if (res.isError) {
    throw new Error(`LLM task failed: ${res.output.slice(0, 500)}`);
  }

  const jsonText = extractJson(res.output);
  if (!jsonText) {
    throw new Error(
      `LLM task response did not contain a JSON object. Got: ${res.output.slice(0, 500)}`,
    );
  }

  let result: T;
  try {
    result = parse(jsonText);
  } catch (err) {
    throw new Error(
      `LLM task JSON parse failed: ${err instanceof Error ? err.message : String(err)}. Raw: ${jsonText.slice(0, 500)}`,
    );
  }

  return { result, sessionId: res.sessionId, costUsd: res.costUsd };
}

/**
 * Extracts the first top-level JSON object from a text blob.
 *
 * Handles three common LLM response shapes:
 *   1. Pure JSON: `{...}`
 *   2. JSON inside a markdown code fence: ````json\n{...}\n````
 *   3. JSON with surrounding prose: `Here is the result: {...}`
 *
 * Returns the raw JSON string (without the code fence), or null if no
 * balanced `{...}` object is found.
 */
export function extractJson(text: string): string | null {
  // Try code-fence extraction first
  const fenceMatch = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text);
  if (fenceMatch) {
    return fenceMatch[1]!.trim();
  }

  // Scan for the first balanced top-level object
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (c === '\\') {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}
