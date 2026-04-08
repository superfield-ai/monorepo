import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentOpts, AgentResult } from "../../agent.ts";

/**
 * Layer 2 helper for recorded `codex exec --json` responses.
 *
 * Fixtures live in `tests/fixtures/codex/<name>.jsonl` and are committed to
 * the repo. Capture them with the Codex fixture recorder.
 */

const DEFAULT_FIXTURES_DIR = path.resolve(
  import.meta.dirname,
  "../../../../tests/fixtures/codex",
);

export async function loadCodexFixture(
  name: string,
  fixturesDir: string = DEFAULT_FIXTURES_DIR,
): Promise<string> {
  const filePath = path.join(fixturesDir, `${name}.jsonl`);
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    throw new Error(
      `Codex fixture not found: ${name} (looked in ${filePath}). ` +
        `Record it with the Codex fixture recorder.`,
    );
  }
}

export async function replayCodexSpawn(
  name: string,
  fixturesDir: string = DEFAULT_FIXTURES_DIR,
): Promise<(opts: AgentOpts) => Promise<AgentResult>> {
  const fixture = await loadCodexFixture(name, fixturesDir);
  return async (_opts: AgentOpts) => parseCodexJsonl(fixture);
}

function parseCodexJsonl(raw: string): AgentResult {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  let sessionId = "";
  let output = "";
  let isError = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    const event = JSON.parse(trimmed) as Record<string, unknown>;
    if (
      event.type === "thread.started" &&
      typeof event.thread_id === "string"
    ) {
      sessionId = event.thread_id;
      continue;
    }
    if (event.type === "item.completed") {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === "agent_message") {
        output = readTextField(item);
      } else if (item?.type === "error") {
        isError = true;
        output = readTextField(item);
      }
      continue;
    }
    if (event.type === "error") {
      isError = true;
      output = readTextField(event);
    }
  }

  if (!sessionId) {
    throw new Error("Codex fixture did not contain a thread_id");
  }

  return { sessionId, output, isError };
}

function readTextField(obj: Record<string, unknown>): string {
  if (typeof obj.text === "string") return obj.text;
  if (typeof obj.error === "string") return obj.error;
  if (typeof obj.message === "string") return obj.message;
  if (typeof obj.result === "string") return obj.result;
  return "";
}
