import {
  runDeployCommand,
  runDemoTeardown,
  DEFAULT_DEMO_PORT,
  runGcpDeployCommand,
  handleLoginLogout,
  makeDefaultLoginDeps,
} from "@superfield/core";
import {
  deployLocalCluster,
  teardownLocalCluster,
} from "@superfield/control-core";

const USAGE = `Usage: superfield deploy [--provision] [target]
       superfield deploy gcp [--project <id>] [--region <r>] [--zone <z>] [--provision] [--image-tag <tag>]
       superfield deploy gcp --login [--client-id <id>]
       superfield deploy gcp --logout`;

export interface ParsedDeployArgs {
  provisionOnly: boolean;
  target?: string;
  // GCP flags
  login?: boolean;
  logout?: boolean;
  gcpProject?: string;
  gcpRegion?: string;
  gcpZone?: string;
  gcpImageTag?: string;
  gcpClientId?: string;
  unknown: string[];
}

export function parseDeployArgs(args: string[]): ParsedDeployArgs {
  let provisionOnly = false;
  let target: string | undefined;
  let login: boolean | undefined;
  let logout: boolean | undefined;
  let gcpProject: string | undefined;
  let gcpRegion: string | undefined;
  let gcpZone: string | undefined;
  let gcpImageTag: string | undefined;
  let gcpClientId: string | undefined;
  const unknown: string[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === undefined) {
      i++;
      continue;
    }
    if (arg === "--provision") {
      provisionOnly = true;
    } else if (arg === "--login") {
      login = true;
    } else if (arg === "--logout") {
      logout = true;
    } else if (arg === "--project") {
      gcpProject = args[++i];
    } else if (arg.startsWith("--project=")) {
      gcpProject = arg.slice("--project=".length);
    } else if (arg === "--region") {
      gcpRegion = args[++i];
    } else if (arg.startsWith("--region=")) {
      gcpRegion = arg.slice("--region=".length);
    } else if (arg === "--zone") {
      gcpZone = args[++i];
    } else if (arg.startsWith("--zone=")) {
      gcpZone = arg.slice("--zone=".length);
    } else if (arg === "--image-tag") {
      gcpImageTag = args[++i];
    } else if (arg.startsWith("--image-tag=")) {
      gcpImageTag = arg.slice("--image-tag=".length);
    } else if (arg === "--client-id") {
      gcpClientId = args[++i];
    } else if (arg.startsWith("--client-id=")) {
      gcpClientId = arg.slice("--client-id=".length);
    } else if (arg.startsWith("--")) {
      unknown.push(arg);
    } else if (target === undefined) {
      target = arg;
    } else {
      unknown.push(arg);
    }
    i++;
  }

  return {
    provisionOnly,
    target,
    login,
    logout,
    gcpProject,
    gcpRegion,
    gcpZone,
    gcpImageTag,
    gcpClientId,
    unknown,
  };
}

export interface DeployCommandDeps {
  fetchPublicIp?: () => Promise<string | null>;
  waitForExit?: () => Promise<void>;
  runGcpDeployCommand?: typeof runGcpDeployCommand;
}

export async function deployCommand(
  args: string[],
  deps: DeployCommandDeps = {},
): Promise<void> {
  const parsed = parseDeployArgs(args);

  // GCP target
  if (parsed.target === "gcp") {
    await handleGcpTarget(parsed, deps);
    return;
  }

  if (parsed.unknown.length > 0) {
    console.error(USAGE);
    process.exit(1);
    return;
  }

  // When --path is provided, use the unified control-core deploy path which
  // does not require per-app scripts/local-demo.ts.
  if (parsed.path) {
    const appRoot = parsed.path;
    await deployLocalCluster({ appRoot, verbose: true });

    if (parsed.provisionOnly) return;

    console.log("\nDeploy complete. Press Ctrl+C to tear down.");
    await (deps.waitForExit ?? waitForSigint)();

    process.stdout.write("\n");
    console.log("Tearing down cluster...");
    process.once("SIGINT", () => process.exit(1));
    try {
      teardownLocalCluster({ appRoot });
    } finally {
      process.exit(0);
    }
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

async function handleGcpTarget(
  parsed: ParsedDeployArgs,
  deps: DeployCommandDeps,
): Promise<void> {
  const loginDeps = makeDefaultLoginDeps();

  // Handle --login / --logout
  const wasHandled = await handleLoginLogout(
    {
      login: parsed.login,
      logout: parsed.logout,
      clientId: parsed.gcpClientId ?? process.env["GCP_OAUTH_CLIENT_ID"],
    },
    loginDeps,
  );

  if (wasHandled) {
    // --logout exits immediately; --login continues with fresh token
    if (parsed.logout) return;
  }

  // Validate --project
  const projectId = parsed.gcpProject ?? process.env["GCP_PROJECT_ID"];
  if (!projectId) {
    console.error(
      "error: --project <id> (or GCP_PROJECT_ID env var) is required for gcp target",
    );
    console.error(USAGE);
    process.exit(1);
    return;
  }

  const region = parsed.gcpRegion ?? "us-central1";
  const zone = parsed.gcpZone ?? "us-central1-a";

  const _runGcpDeployCommand = deps.runGcpDeployCommand ?? runGcpDeployCommand;

  await _runGcpDeployCommand({
    projectId,
    region,
    zone,
    imageTag: parsed.gcpImageTag,
    provisionOnly: parsed.provisionOnly,
    logger: (msg) => console.log(msg),
  });
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
