/**
 * Records real `codex exec --json` responses as test fixtures.
 *
 * Usage:
 *   bun scripts/record-codex-fixtures.ts <fixture-name> --prompt "..." [--cwd <dir>] [--model <name>]
 *
 * The script writes the raw JSONL stream to `tests/fixtures/codex/<fixture-name>.jsonl`.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const FIXTURES_DIR = path.resolve(
  import.meta.dirname,
  "../tests/fixtures/codex",
);

interface RecorderArgs {
  name: string;
  prompt: string;
  cwd?: string;
  model?: string;
}

function parseArgs(argv: string[]): RecorderArgs {
  const args: RecorderArgs = { name: "", prompt: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--prompt") {
      args.prompt = argv[++i] ?? "";
    } else if (a === "--cwd") {
      args.cwd = argv[++i];
    } else if (a === "--model") {
      args.model = argv[++i];
    } else if (!args.name) {
      args.name = a;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.name || !args.prompt) {
    console.error(
      'Usage: bun scripts/record-codex-fixtures.ts <fixture-name> --prompt "..." [--cwd <dir>] [--model <name>]',
    );
    process.exit(1);
  }

  const cwd = args.cwd ?? process.cwd();
  const cliArgs = [
    "exec",
    "--json",
    "--ephemeral",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    "-C",
    cwd,
  ];
  if (args.model) cliArgs.push("--model", args.model);
  cliArgs.push(args.prompt);

  console.log(`Recording Codex fixture: ${args.name}`);
  const raw = await runCodex(cliArgs, cwd);

  await fs.mkdir(FIXTURES_DIR, { recursive: true });
  const outPath = path.join(FIXTURES_DIR, `${args.name}.jsonl`);
  await fs.writeFile(outPath, raw, "utf8");
  console.log(`✓ Wrote ${outPath}`);
}

async function runCodex(args: string[], cwd: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const proc = spawn("codex", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    proc.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    proc.on("error", (err) =>
      reject(new Error(`Failed to spawn codex: ${err.message}`)),
    );
    proc.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code && code !== 0) {
        reject(
          new Error(
            `codex exited with code ${code}.\nstdout: ${stdout.slice(0, 500)}\nstderr: ${stderr.slice(0, 500)}`,
          ),
        );
        return;
      }
      resolve(stdout);
    });
  });
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  await main();
}
