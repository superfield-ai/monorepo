/**
 * Records real `claude --print --output-format json` responses as golden
 * fixtures for the studio chat integration tests.
 *
 * Usage:
 *   bun scripts/record-studio-chat-goldens.ts [scenario] [--list]
 *
 * Examples:
 *   bun scripts/record-studio-chat-goldens.ts           # record all scenarios
 *   bun scripts/record-studio-chat-goldens.ts question  # record one scenario
 *   bun scripts/record-studio-chat-goldens.ts --list    # list available scenarios
 *
 * Requires:
 *   - `claude` CLI on PATH and authenticated
 *
 * Goldens are saved to:
 *   packages/control/tests/fixtures/studio-goldens/{scenario}.json
 *
 * Commit the updated golden files so CI can replay them without Claude access.
 * Re-record only when Claude's output format changes or when the expected
 * content for a scenario needs to be refreshed.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const GOLDENS_DIR = path.resolve(
  import.meta.dirname,
  "../packages/control/tests/fixtures/studio-goldens",
);

interface Scenario {
  message: string;
  description: string;
}

const SCENARIOS: Record<string, Scenario> = {
  question: {
    message:
      "What is this codebase and what can you help me with in studio mode? Give a brief overview.",
    description: "Question-mode turn: codebase overview without code changes",
  },
  design: {
    message:
      "Add a one-sentence comment at the top of README.md explaining what this repo is. Use a markdown comment (HTML comment style).",
    description: "Design-mode turn: minimal additive file change",
  },
};

interface ClaudeJsonResult {
  type: string;
  subtype: string;
  is_error: boolean;
  session_id: string;
  result?: string;
  error?: string;
  cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
}

async function runClaude(message: string): Promise<ClaudeJsonResult> {
  const result = spawnSync(
    "claude",
    [
      "--print",
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
      "--allowed-tools",
      "Read,Write,Edit,Bash,Glob,Grep",
      message,
    ],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      env: { ...process.env },
      timeout: 120_000,
    },
  );

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() ?? "";
    throw new Error(`claude exited ${result.status}: ${stderr}`);
  }

  const raw = result.stdout?.trim() ?? "";
  if (!raw) throw new Error("claude produced no output");

  return JSON.parse(raw) as ClaudeJsonResult;
}

function parseArgs(argv: string[]): { list: boolean; scenario?: string } {
  const result: { list: boolean; scenario?: string } = { list: false };
  for (const arg of argv) {
    if (arg === "--list") result.list = true;
    else if (!arg.startsWith("--")) result.scenario = arg;
  }
  return result;
}

async function main(): Promise<void> {
  const { list, scenario } = parseArgs(process.argv.slice(2));

  if (list) {
    console.log("Studio chat golden scenarios:\n");
    for (const [name, s] of Object.entries(SCENARIOS)) {
      console.log(`  ${name}`);
      console.log(`    ${s.description}\n`);
    }
    return;
  }

  const toRecord = scenario ? { [scenario]: SCENARIOS[scenario] } : SCENARIOS;

  if (scenario && !SCENARIOS[scenario]) {
    console.error(`Unknown scenario: ${scenario}`);
    console.error("Run with --list to see available scenarios.");
    process.exit(1);
  }

  await fs.mkdir(GOLDENS_DIR, { recursive: true });

  for (const [name, s] of Object.entries(toRecord)) {
    if (!s) continue;
    console.log(`Recording: ${name}`);
    console.log(`  ${s.description}`);
    console.log(`  Prompt: "${s.message.slice(0, 80)}..."`);

    try {
      const golden = await runClaude(s.message);
      const outPath = path.join(GOLDENS_DIR, `${name}.json`);
      await fs.writeFile(
        outPath,
        JSON.stringify(golden, null, 0) + "\n",
        "utf8",
      );
      console.log(
        `  ✓ Saved ${outPath}  cost=$${(golden.cost_usd ?? 0).toFixed(4)}  ms=${golden.duration_ms ?? 0}`,
      );
    } catch (err) {
      console.error(
        `  ✗ Failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    console.log();
  }
}

await main();
