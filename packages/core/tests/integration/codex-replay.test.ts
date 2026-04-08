import { describe, it, expect } from "vitest";
import { runLLMTask } from "../../llm-task.ts";
import { replayCodexSpawn } from "../helpers/codex-replay.ts";

describe("Codex replay integration", () => {
  it("replays a recorded codex JSONL response through runLLMTask", async () => {
    const spawn = await replayCodexSpawn("test-sample");
    const result = await runLLMTask(
      { prompt: "return json", spawn },
      (json) => JSON.parse(json) as { answer: number },
    );

    expect(result.sessionId).toMatch(/^019d6e98-/);
    expect(result.result).toEqual({ answer: 42 });
  });
});
