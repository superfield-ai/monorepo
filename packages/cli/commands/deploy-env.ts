import { readFileSync } from "node:fs";
import { deployEnv } from "@superfield/core";

const USAGE = `Usage: superfield deploy-env --repo <owner/name> --env <e> --tag <t> --app-name <name>
                            [--workers <a,b,c>] [--health-path <p>]
                            [--namespace <ns>] [--dry-run] [--json]
                            [--clean-room] [--db-mode <local|managed>]

Environment:
  DEPLOY_HOST           SSH host of the target VM (required)
  DEPLOY_KEY            PEM-encoded private deploy key (required, multiline OK)
  DEPLOY_KEY_FILE       Alternative: path to PEM file (used if DEPLOY_KEY unset)
  DEPLOY_USER           SSH user (default: root)
  DEPLOY_KNOWN_HOSTS    Path to known_hosts file (default: ~/.ssh/known_hosts.superfield)
  DEPLOY_IMAGE_REPO     Override image repo (default: ghcr.io/<repo lowercase>)
  GITHUB_TOKEN          GitHub token (falls back to 'gh auth token')`;

export interface ParsedDeployEnvArgs {
  repo?: string;
  env?: string;
  tag?: string;
  appName?: string;
  workers?: string[];
  healthPath?: string;
  namespace?: string;
  dryRun: boolean;
  json: boolean;
  cleanRoom: boolean;
  dbMode?: "local" | "managed";
  unknown: string[];
}

export function parseDeployEnvArgs(args: string[]): ParsedDeployEnvArgs {
  const out: ParsedDeployEnvArgs = {
    dryRun: false,
    json: false,
    cleanRoom: false,
    unknown: [],
  };
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === undefined) {
      i++;
      continue;
    }
    const take = (): string | undefined => args[++i];
    const eq = (prefix: string): string | undefined =>
      a.startsWith(prefix) ? a.slice(prefix.length) : undefined;
    let v: string | undefined;
    if (a === "--repo") out.repo = take();
    else if ((v = eq("--repo=")) !== undefined) out.repo = v;
    else if (a === "--env") out.env = take();
    else if ((v = eq("--env=")) !== undefined) out.env = v;
    else if (a === "--tag") out.tag = take();
    else if ((v = eq("--tag=")) !== undefined) out.tag = v;
    else if (a === "--app-name") out.appName = take();
    else if ((v = eq("--app-name=")) !== undefined) out.appName = v;
    else if (a === "--workers")
      out.workers = (take() ?? "").split(",").filter(Boolean);
    else if ((v = eq("--workers=")) !== undefined)
      out.workers = v.split(",").filter(Boolean);
    else if (a === "--health-path") out.healthPath = take();
    else if ((v = eq("--health-path=")) !== undefined) out.healthPath = v;
    else if (a === "--namespace") out.namespace = take();
    else if ((v = eq("--namespace=")) !== undefined) out.namespace = v;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--json") out.json = true;
    else if (a === "--clean-room") out.cleanRoom = true;
    else if (a === "--db-mode") {
      const dm = take();
      if (dm === "local" || dm === "managed") out.dbMode = dm;
      else out.unknown.push(`--db-mode=${dm ?? ""}`);
    } else if ((v = eq("--db-mode=")) !== undefined) {
      if (v === "local" || v === "managed") out.dbMode = v;
      else out.unknown.push(a);
    } else out.unknown.push(a);
    i++;
  }
  return out;
}

export async function deployEnvCommand(args: string[]): Promise<void> {
  const parsed = parseDeployEnvArgs(args);
  if (parsed.unknown.length > 0) {
    console.error(`error: unknown argument(s): ${parsed.unknown.join(" ")}`);
    console.error(USAGE);
    process.exit(1);
    return;
  }
  const missing: string[] = [];
  if (!parsed.repo) missing.push("--repo");
  if (!parsed.env) missing.push("--env");
  if (!parsed.tag) missing.push("--tag");
  if (!parsed.appName) missing.push("--app-name");
  if (
    missing.length ||
    !parsed.repo ||
    !parsed.env ||
    !parsed.tag ||
    !parsed.appName
  ) {
    console.error(`error: missing required flag(s): ${missing.join(", ")}`);
    console.error(USAGE);
    process.exit(1);
    return;
  }
  const { repo, env, tag, appName } = parsed;

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
    process.env.DEPLOY_KNOWN_HOSTS ??
    `${process.env.HOME ?? ""}/.ssh/known_hosts.superfield`;

  const collected: { line: string }[] = [];
  const onLog = parsed.json
    ? (line: string) => collected.push({ line })
    : (line: string) => process.stdout.write(line + "\n");

  try {
    const result = await deployEnv({
      repo,
      env,
      tag,
      appName,
      workerNames: parsed.workers ?? [],
      ...(parsed.healthPath ? { healthPath: parsed.healthPath } : {}),
      ...(parsed.namespace ? { appNamespace: parsed.namespace } : {}),
      host,
      sshUser,
      sshPrivateKeyPem,
      knownHostsPath,
      ...(process.env.DEPLOY_IMAGE_REPO
        ? { imageRepo: process.env.DEPLOY_IMAGE_REPO }
        : {}),
      dryRun: parsed.dryRun,
      // When --clean-room is requested without an explicit --db-mode the
      // operator's intent is unambiguous: clean-room only applies to
      // local-mode databases, so default the mode there.
      ...(parsed.cleanRoom ? { cleanRoom: true } : {}),
      ...(parsed.cleanRoom || parsed.dbMode
        ? { dbMode: parsed.dbMode ?? "local" }
        : {}),
      onLog,
    });
    if (parsed.json) {
      process.stdout.write(
        JSON.stringify({ ok: true, ...result, log: collected }) + "\n",
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (parsed.json) {
      process.stdout.write(
        JSON.stringify({ ok: false, error: message, log: collected }) + "\n",
      );
    } else {
      console.error(`deploy-env failed: ${message}`);
    }
    process.exit(1);
  }
}
