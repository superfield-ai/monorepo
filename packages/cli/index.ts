import { githubCommand } from "./commands/github.ts";
import { startCommand } from "./commands/start.ts";
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
  start <path> [slotCount]
                Begin the continuous development loop
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
    const slotCount = parseSlotCount(third);
    if (third !== undefined && slotCount === null) {
      console.warn(
        `[warn] Ignoring invalid slot count ${JSON.stringify(third)}; using the default slot count`,
      );
    }
    await startCommand(sub, {
      ...(slotCount !== null ? { slotCount } : {}),
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
