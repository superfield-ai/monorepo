import { describe, it, expect } from 'vitest';
import { runLLMTask, extractJson } from '../../llm-task.ts';
import type { AgentOpts, AgentResult } from '../../agent.ts';

describe('extractJson', () => {
  it('returns a pure JSON object unchanged', () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });

  it('extracts JSON from a markdown code fence', () => {
    const text = 'Here is the result:\n```json\n{"a":1,"b":2}\n```\nDone.';
    expect(extractJson(text)).toBe('{"a":1,"b":2}');
  });

  it('extracts JSON from a bare code fence', () => {
    expect(extractJson('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('extracts JSON surrounded by prose', () => {
    const text = 'The answer is {"answer": 42} as requested.';
    expect(extractJson(text)).toBe('{"answer": 42}');
  });

  it('handles nested objects', () => {
    expect(extractJson('{"a":{"b":{"c":1}}}')).toBe('{"a":{"b":{"c":1}}}');
  });

  it('ignores braces inside strings', () => {
    expect(extractJson('{"text":"hello { world }"}')).toBe('{"text":"hello { world }"}');
  });

  it('handles escaped quotes inside strings', () => {
    expect(extractJson('{"text":"she said \\"hi\\""}')).toBe(
      '{"text":"she said \\"hi\\""}',
    );
  });

  it('returns null when no object is present', () => {
    expect(extractJson('no json here')).toBe(null);
  });

  it('returns first object when multiple exist', () => {
    expect(extractJson('{"a":1} {"b":2}')).toBe('{"a":1}');
  });
});

describe('runLLMTask', () => {
  const fakeSpawn = (output: string, isError = false) =>
    async (_opts: AgentOpts): Promise<AgentResult> => ({
      sessionId: 'sess-123',
      output,
      isError,
      costUsd: 0.01,
    });

  it('parses a pure JSON response', async () => {
    const result = await runLLMTask<{ a: number }>(
      { prompt: 'x', spawn: fakeSpawn('{"a":1}') },
      (json) => JSON.parse(json) as { a: number },
    );
    expect(result.result).toEqual({ a: 1 });
    expect(result.sessionId).toBe('sess-123');
  });

  it('parses JSON inside a code fence', async () => {
    const result = await runLLMTask<{ a: number }>(
      { prompt: 'x', spawn: fakeSpawn('```json\n{"a":42}\n```') },
      (json) => JSON.parse(json) as { a: number },
    );
    expect(result.result).toEqual({ a: 42 });
  });

  it('throws when agent reports error', async () => {
    await expect(
      runLLMTask(
        { prompt: 'x', spawn: fakeSpawn('boom', true) },
        (json) => JSON.parse(json),
      ),
    ).rejects.toThrow(/LLM task failed/);
  });

  it('throws when response contains no JSON', async () => {
    await expect(
      runLLMTask(
        { prompt: 'x', spawn: fakeSpawn('just prose') },
        (json) => JSON.parse(json),
      ),
    ).rejects.toThrow(/did not contain a JSON object/);
  });

  it('throws when parse function throws', async () => {
    await expect(
      runLLMTask(
        { prompt: 'x', spawn: fakeSpawn('{"a":1}') },
        () => {
          throw new Error('bad shape');
        },
      ),
    ).rejects.toThrow(/JSON parse failed.*bad shape/);
  });
});
