import {
  runDeployCommand,
  runDemoTeardown,
  DEFAULT_DEMO_PORT,
} from "@superfield/core";

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

export async function deployCommand(
  args: string[],
  deps: DeployCommandDeps = {},
): Promise<void> {
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

  if (parsed.provisionOnly) return;

  const port = DEFAULT_DEMO_PORT;
  const publicIp = await (deps.fetchPublicIp ?? fetchPublicIp)();

  console.log("\nDemo is live:");
  console.log(`  local:  http://localhost:${port}/`);
  if (publicIp) {
    console.log(`  public: http://${publicIp}:${port}/`);
  }
  console.log("\nPress Ctrl+C to stop and destroy the demo cluster.");

  await (deps.waitForExit ?? waitForSigint)();

  process.stdout.write("\n");
  console.log("Stopping demo cluster...");
  process.once("SIGINT", () => process.exit(1));

  try {
    await runDemoTeardown();
  } finally {
    process.exit(0);
  }
}

export interface DeployCommandDeps {
  fetchPublicIp?: () => Promise<string | null>;
  waitForExit?: () => Promise<void>;
}

async function fetchPublicIp(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    const res = await fetch("https://api.ipify.org", {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) return (await res.text()).trim();
  } catch {
    // network unavailable or timeout — skip public URL
  }
  return null;
}

function waitForSigint(): Promise<void> {
  return new Promise((resolve) => process.once("SIGINT", resolve));
}
