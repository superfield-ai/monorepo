import { exportDb } from "@superfield/core";
import type { DbProvider } from "@superfield/core";

const USAGE = `Usage: superfield export-db --env <e> --out <path> [--repo <owner/name>] [--provider <gcp|aws|digitalocean|vultr>]

Options:
  --env <e>              Environment name (e.g. prod, staging)
  --out <path>           Output file path for the dump or receipt
  --repo <owner/name>    GitHub repo (default: reads from git remote)
  --provider <p>         Force a specific DB provider (auto-detected by default)

Environment:
  DEPLOY_HOST            SSH host for local-mode pg_dump
  DEPLOY_KEY             PEM-encoded private deploy key
  DEPLOY_KEY_FILE        Alternative: path to PEM key file
  DEPLOY_USER            SSH user (default: root)
  DEPLOY_KNOWN_HOSTS     Path to known_hosts file (default: ~/.ssh/known_hosts.superfield)
  DATABASE_URL_<ENV>     Database URL for mode detection (reads from GitHub secrets)
  GCP_PROJECT_ID         GCP project ID (for AlloyDB backups)
  GCP_REGION             GCP region (default: us-central1)
  ALLOYDB_CLUSTER_ID     AlloyDB cluster ID (default: superfield-db)
  ALLOYDB_INSTANCE_ID    AlloyDB instance ID (default: superfield-db-primary)
  RDS_DB_INSTANCE_ID     AWS RDS instance identifier`;

const VALID_PROVIDERS: DbProvider[] = ["gcp", "aws", "digitalocean", "vultr"];

export interface ParsedExportDbArgs {
  env?: string;
  out?: string;
  repo?: string;
  provider?: DbProvider;
  unknown: string[];
}

export function parseExportDbArgs(args: string[]): ParsedExportDbArgs {
  const out: ParsedExportDbArgs = { unknown: [] };
  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    const take = () => args[++i];
    const eq = (prefix: string) =>
      a.startsWith(prefix) ? a.slice(prefix.length) : null;

    if (a === "--env") out.env = take();
    else if (eq("--env=") !== null) out.env = eq("--env=")!;
    else if (a === "--out") out.out = take();
    else if (eq("--out=") !== null) out.out = eq("--out=")!;
    else if (a === "--repo") out.repo = take();
    else if (eq("--repo=") !== null) out.repo = eq("--repo=")!;
    else if (a === "--provider") {
      const v = take();
      if (v && VALID_PROVIDERS.includes(v as DbProvider)) {
        out.provider = v as DbProvider;
      } else {
        out.unknown.push(`--provider=${v ?? ""}`);
      }
    } else if (eq("--provider=") !== null) {
      const v = eq("--provider=")!;
      if (VALID_PROVIDERS.includes(v as DbProvider)) {
        out.provider = v as DbProvider;
      } else {
        out.unknown.push(a);
      }
    } else out.unknown.push(a);

    i++;
  }
  return out;
}

export async function exportDbCommand(args: string[]): Promise<void> {
  const parsed = parseExportDbArgs(args);

  if (parsed.unknown.length > 0) {
    console.error(`error: unknown argument(s): ${parsed.unknown.join(" ")}`);
    console.error(USAGE);
    process.exit(1);
    return;
  }

  const missing: string[] = [];
  if (!parsed.env) missing.push("--env");
  if (!parsed.out) missing.push("--out");
  if (missing.length) {
    console.error(`error: missing required flag(s): ${missing.join(", ")}`);
    console.error(USAGE);
    process.exit(1);
    return;
  }

  // Repo is optional: if not provided, exportDb will try env vars / fallbacks
  const repo = parsed.repo ?? "";

  try {
    const result = await exportDb({
      repo,
      env: parsed.env!,
      out: parsed.out!,
      provider: parsed.provider,
      deps: {
        onLog: (line: string) => process.stdout.write(line + "\n"),
      },
    });
    process.stdout.write(
      `export-db complete: ${result.outPath} (${result.bytes} bytes, ${result.sha256})\n`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`export-db failed: ${message}`);
    process.exit(1);
  }
}
