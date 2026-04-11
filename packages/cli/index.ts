import { githubCommand } from "./commands/github.ts";
import { startCommand, type StartLoop } from "./commands/start.ts";
import { planCommand } from "./commands/plan.ts";
import { featureCommand } from "./commands/feature.ts";
const BUILD_VERSION = process.env.SUPERFIELD_BUILD_VERSION ?? "dev";
const BUILD_COMMIT = process.env.SUPERFIELD_BUILD_COMMIT ?? "unknown";
const BUILD_DATE = process.env.SUPERFIELD_BUILD_DATE ?? "unknown";

function usage(): string {
  return `
superfield — GitOps AI orchestrator

Version: ${BUILD_VERSION}
Commit: ${BUILD_COMMIT}
Build date: ${BUILD_DATE}

Commands:
  github add    Authenticate and register a repository
  github forget Remove credentials and print app uninstall link
  start <path> [slotCount] [--plan] [--dev] [--doc]
                Begin loop(s). Defaults to all three when no --<loop> flags are provided.
  plan          Replan: group issues into phases, create scouts, write Plan
  feature "..." Evaluate a feature request and create an issue + Plan entry
`.trim();
}

export async function runCLI(args: string[]): Promise<void> {
  const [cmd, sub, third] = args;

  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(usage());
    return;
  }

  if (cmd === "github") {
    await githubCommand(sub, third);
    return;
  }

  if (cmd === "start") {
    const parsed = parseStartArgs(args.slice(1));
    if (parsed.unknown.length > 0) {
      console.error(
        `[error] Unknown start argument(s): ${parsed.unknown.join(" ")}`,
      );
      process.exit(1);
      return;
    }
    const slotCount = parseSlotCount(parsed.slotCountRaw);
    if (parsed.slotCountRaw !== undefined && slotCount === null) {
      console.warn(
        `[warn] Ignoring invalid slot count ${JSON.stringify(parsed.slotCountRaw)}; using the default slot count`,
      );
    }
    await startCommand(parsed.repoPath, {
      ...(slotCount !== null ? { slotCount } : {}),
      loops: parsed.loops,
    });
    return;
  }

  if (cmd === "plan") {
    await planCommand(sub);
    return;
  }

  if (cmd === "feature") {
    await featureCommand(sub, third);
    return;
  }

  console.log(usage());
  process.exit(cmd ? 1 : 0);
}

export function parseSlotCount(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return parsed;
}

export interface ParsedStartArgs {
  repoPath: string | undefined;
  slotCountRaw: string | undefined;
  loops: StartLoop[];
  unknown: string[];
}

export function parseStartArgs(args: string[]): ParsedStartArgs {
  const loopSet = new Set<StartLoop>();
  const positionals: string[] = [];
  const unknown: string[] = [];

  for (const arg of args) {
    if (arg === "--plan") {
      loopSet.add("plan");
      continue;
    }
    if (arg === "--dev") {
      loopSet.add("dev");
      continue;
    }
    if (arg === "--doc") {
      loopSet.add("doc");
      continue;
    }
    if (arg.startsWith("--")) {
      unknown.push(arg);
      continue;
    }
    positionals.push(arg);
  }

  if (positionals.length > 2) {
    unknown.push(...positionals.slice(2));
  }

  const loops: StartLoop[] =
    loopSet.size > 0 ? Array.from(loopSet) : ["plan", "dev", "doc"];

  return {
    repoPath: positionals[0],
    slotCountRaw: positionals[1],
    loops,
    unknown,
  };
}
