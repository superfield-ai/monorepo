import { spawnAgent, type AgentOpts, type AgentResult } from "./agent.ts";

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
 * Extracts a JSON object from an LLM response. **Strict** by design — we
 * refuse to guess at prose-wrapped JSON because that's how production
 * agents start emitting wrong values.
 *
 * Two acceptable shapes:
 *   1. Pure JSON object: trimmed text starts with `{` and ends with `}`
 *      and contains exactly one top-level object.
 *   2. JSON inside a markdown code fence: ` ```json ... ``` ` or ` ``` ... ``` `.
 *      Inside a fence we trust the model and return the fence body verbatim,
 *      even if it contains multiple objects (the parser downstream decides).
 *
 * Refuses (returns `null`):
 *   - Inline JSON wrapped in prose (e.g. "The answer is {...}")
 *   - Multiple bare top-level objects outside a fence
 *   - Anything where the first non-whitespace char isn't `{` or a fence
 *
 * If we cannot identify the JSON cleanly, the caller throws — better than
 * silently parsing the wrong object.
 */
export function extractJson(text: string): string | null {
  // 1. Try code-fence extraction first — fences are the trusted path
  const fenceMatch = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text);
  if (fenceMatch) {
    return fenceMatch[1]!.trim();
  }

  // 2. Outside a fence, the trimmed text MUST be a single top-level object
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed[0] !== "{") return null;

  // Walk balanced braces from index 0 — must consume the entire trimmed text
  let depth = 0;
  let inString = false;
  let escape = false;
  let endIdx = -1;

  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (c === "\\") {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }

  if (endIdx < 0) return null;

  // Anything after the closing brace must be only whitespace, otherwise
  // we have either trailing prose or another top-level object — both refused
  const trailing = trimmed.slice(endIdx + 1).trim();
  if (trailing.length > 0) return null;

  return trimmed.slice(0, endIdx + 1);
}
