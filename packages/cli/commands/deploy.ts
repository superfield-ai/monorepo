import {
  runDeployCommand,
  runDemoTeardown,
  runRemoteProvision,
  DEFAULT_DEMO_PORT,
} from "@superfield/core";

const USAGE = `Usage: superfield deploy [--provision] [target]
       superfield deploy <host> --user <sudo-user> [--key <private-key-path>]`;

export interface ParsedDeployArgs {
  provisionOnly: boolean;
  target?: string;
  remoteUser?: string;
  remoteKeyPath?: string;
  unknown: string[];
}

export function parseDeployArgs(args: string[]): ParsedDeployArgs {
  let provisionOnly = false;
  let target: string | undefined;
  let remoteUser: string | undefined;
  let remoteKeyPath: string | undefined;
  const unknown: string[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--provision") {
      provisionOnly = true;
    } else if (arg === "--user") {
      remoteUser = args[++i];
    } else if (arg.startsWith("--user=")) {
      remoteUser = arg.slice("--user=".length);
    } else if (arg === "--key") {
      remoteKeyPath = args[++i];
    } else if (arg.startsWith("--key=")) {
      remoteKeyPath = arg.slice("--key=".length);
    } else if (arg.startsWith("--")) {
      unknown.push(arg);
    } else if (target === undefined) {
      target = arg;
    } else {
      unknown.push(arg);
    }
    i++;
  }

  return { provisionOnly, target, remoteUser, remoteKeyPath, unknown };
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

  const isRemote = parsed.target !== undefined && parsed.target !== "demo";

  if (isRemote) {
    if (!parsed.remoteUser) {
      console.error(
        "error: --user <sudo-user> is required for remote deployment",
      );
      console.error(USAGE);
      process.exit(1);
      return;
    }
    const result = await (deps.runRemoteProvision ?? runRemoteProvision)({
      host: parsed.target!,
      user: parsed.remoteUser,
      ...(parsed.remoteKeyPath ? { keyPath: parsed.remoteKeyPath } : {}),
    });
    const line = "─".repeat(60);
    console.log("\n==> Remote provisioning complete!");
    console.log("\nDeploy key — add to GitHub repo → Settings → Deploy keys:");
    console.log(line);
    console.log(result.deployPublicKey);
    console.log(line);
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
  runRemoteProvision?: typeof runRemoteProvision;
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
