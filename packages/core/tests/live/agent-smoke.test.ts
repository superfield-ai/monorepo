import { expect } from "vitest";
import { runLLMTask } from "../../llm-task.ts";
import { liveBackends, liveDescribe, liveIt } from "../helpers/live.ts";

/**
 * Layer 3 — live smoke tests against the real agent CLIs.
 *
 * Skipped unless SUPERFIELD_LIVE_AGENTS is set. Runs nightly or before a
 * release. See docs/testing.md §Layer 3.
 */
liveDescribe("agent CLI live smoke", () => {
  for (const backend of liveBackends()) {
    liveIt(`parses a simple JSON response with ${backend}`, async () => {
      const result = await runLLMTask(
        {
          prompt: 'Return only the exact JSON object {"ok":true}.',
          provider: backend,
          maxTurns: 3,
        },
        (json) => JSON.parse(json) as { ok: boolean },
      );

      expect(result.result).toEqual({ ok: true });
      expect(result.sessionId.length).toBeGreaterThan(0);
    });
  }
});
