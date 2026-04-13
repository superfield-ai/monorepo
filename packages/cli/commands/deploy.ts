import { runDeployCommand } from "@superfield/core";

const USAGE = "Usage: superfield deploy [--provision] [target]";

export interface ParsedDeployArgs {
  provisionOnly: boolean;
  target?: string;
  unknown: string[];
}

export function parseDeployArgs(args: string[]): ParsedDeployArgs {
  let provisionOnly = false;
  let target: string | undefined;
  const unknown: string[] = [];

  for (const arg of args) {
    if (arg === "--provision") {
      provisionOnly = true;
      continue;
    }
    if (arg.startsWith("--")) {
      unknown.push(arg);
      continue;
    }
    if (target === undefined) {
      target = arg;
      continue;
    }
    unknown.push(arg);
  }

  return {
    provisionOnly,
    target,
    unknown,
  };
}

export async function deployCommand(args: string[]): Promise<void> {
  const parsed = parseDeployArgs(args);
  if (parsed.unknown.length > 0) {
    console.error(USAGE);
    process.exit(1);
    return;
  }

  await runDeployCommand({
    provisionOnly: parsed.provisionOnly,
    ...(parsed.target ? { target: parsed.target } : {}),
  });
}
