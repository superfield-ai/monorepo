import { readFileSync } from "node:fs";
import { rollbackEnv } from "@superfield/core";

const USAGE = `Usage: superfield rollback-env --repo <owner/name> --env <e> --app-name <name>
                              [--workers <a,b,c>] [--health-path <p>]
                              [--namespace <ns>] [--json]

Environment:
  DEPLOY_HOST           SSH host of the target VM (required)
  DEPLOY_KEY            PEM-encoded private deploy key (required, multiline OK)
  DEPLOY_KEY_FILE       Alternative: path to PEM file (used if DEPLOY_KEY unset)
  DEPLOY_USER           SSH user (default: root)
  DEPLOY_KNOWN_HOSTS    Path to known_hosts file (default: ~/.ssh/known_hosts.superfield)
  GITHUB_TOKEN          GitHub token for deployment annotation (optional; falls back to 'gh auth token')`;

export interface ParsedRollbackEnvArgs {
  repo?: string;
  env?: string;
  appName?: string;
  workers?: string[];
  healthPath?: string;
  namespace?: string;
  json: boolean;
  unknown: string[];
}

export function parseRollbackEnvArgs(args: string[]): ParsedRollbackEnvArgs {
  const out: ParsedRollbackEnvArgs = { json: false, unknown: [] };
  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    const take = () => args[++i];
    const eq = (prefix: string) =>
      a.startsWith(prefix) ? a.slice(prefix.length) : null;
    if (a === "--repo") out.repo = take();
    else if (eq("--repo=") !== null) out.repo = eq("--repo=")!;
    else if (a === "--env") out.env = take();
    else if (eq("--env=") !== null) out.env = eq("--env=")!;
    else if (a === "--app-name") out.appName = take();
    else if (eq("--app-name=") !== null) out.appName = eq("--app-name=")!;
    else if (a === "--workers") {
      out.workers = (take() ?? "").split(",").filter(Boolean);
    } else if (eq("--workers=") !== null) {
      out.workers = eq("--workers=")!.split(",").filter(Boolean);
    } else if (a === "--health-path") out.healthPath = take();
    else if (eq("--health-path=") !== null) {
      out.healthPath = eq("--health-path=")!;
    } else if (a === "--namespace") out.namespace = take();
    else if (eq("--namespace=") !== null) out.namespace = eq("--namespace=")!;
    else if (a === "--json") out.json = true;
    else out.unknown.push(a);
    i++;
  }
  return out;
}

export async function rollbackEnvCommand(args: string[]): Promise<void> {
  const parsed = parseRollbackEnvArgs(args);
  if (parsed.unknown.length > 0) {
    console.error(`error: unknown argument(s): ${parsed.unknown.join(" ")}`);
    console.error(USAGE);
    process.exit(1);
    return;
  }
  const missing: string[] = [];
  if (!parsed.repo) missing.push("--repo");
  if (!parsed.env) missing.push("--env");
  if (!parsed.appName) missing.push("--app-name");
  if (missing.length) {
    console.error(`error: missing required flag(s): ${missing.join(", ")}`);
    console.error(USAGE);
    process.exit(1);
    return;
  }

  const host = process.env.DEPLOY_HOST;
  if (!host) {
    console.error("error: DEPLOY_HOST environment variable is required");
    console.error(USAGE);
    process.exit(1);
    return;
  }

  const sshUser = process.env.DEPLOY_USER ?? "root";
  let sshPrivateKeyPem = process.env.DEPLOY_KEY;
  if (!sshPrivateKeyPem) {
    const keyFile = process.env.DEPLOY_KEY_FILE;
    if (!keyFile) {
      console.error(
        "error: DEPLOY_KEY (or DEPLOY_KEY_FILE) environment variable is required",
      );
      console.error(USAGE);
      process.exit(1);
      return;
    }
    sshPrivateKeyPem = readFileSync(keyFile, "utf8");
  }
  const knownHostsPath =
    process.env.DEPLOY_KNOWN_HOSTS
    ?? `${process.env.HOME ?? ""}/.ssh/known_hosts.superfield`;

  const collected: { line: string }[] = [];
  const onLog = parsed.json
    ? (line: string) => collected.push({ line })
    : (line: string) => process.stdout.write(line + "\n");

  try {
    const result = await rollbackEnv({
      repo: parsed.repo!,
      env: parsed.env!,
      appName: parsed.appName!,
      workerNames: parsed.workers ?? [],
      ...(parsed.healthPath ? { healthPath: parsed.healthPath } : {}),
      ...(parsed.namespace ? { appNamespace: parsed.namespace } : {}),
      host,
      sshUser,
      sshPrivateKeyPem,
      knownHostsPath,
      onLog,
    });
    if (parsed.json) {
      process.stdout.write(
        JSON.stringify({ ok: result.healthy, ...result, log: collected })
          + "\n",
      );
    } else {
      process.stdout.write(`\nrolledBackTo:\n`);
      for (const [name, image] of Object.entries(result.rolledBackTo)) {
        process.stdout.write(`  ${name} → ${image}\n`);
      }
      process.stdout.write(`healthy: ${result.healthy}\n`);
    }
    if (!result.healthy) {
      process.exit(1);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (parsed.json) {
      process.stdout.write(
        JSON.stringify({ ok: false, error: message, log: collected }) + "\n",
      );
    } else {
      console.error(`rollback-env failed: ${message}`);
    }
    process.exit(1);
  }
}
