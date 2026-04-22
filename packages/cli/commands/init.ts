import { init } from "@superfield/core";
import type { InitProvider } from "@superfield/core";

const USAGE = `Usage: superfield init --env <e> --provider <gcp|aws|digitalocean|vultr> \\
                       --repo <owner/name> --image-tag <t> \\
                       [--managed-db] [--region <r>] [--from-step <n>]

Steps:
  1  provision    Create VM + optional managed DB on the target cloud provider
  2  bootstrap    Run install.sh on the fresh VM and wait for k3s readiness
  3  deploy-key   Register per-env SSH deploy key on the application repo
  4  secrets      Push DEPLOY_HOST / DATABASE_URL / WEBHOOK_SECRET / COOKIE_SECRET
  5  sync         Open a PR updating the vendored workflow templates
  6  deploy       Roll out the requested image tag

Environment (step 6):
  DEPLOY_KEY         PEM-encoded private deploy key (required for step 6)
  DEPLOY_KEY_FILE    Alternative: path to PEM file (used if DEPLOY_KEY unset)
  GITHUB_TOKEN       GitHub token (falls back to 'gh auth token')`;

export interface ParsedInitArgs {
  env?: string;
  provider?: string;
  repo?: string;
  imageTag?: string;
  managedDb: boolean;
  region?: string;
  fromStep?: number;
  unknown: string[];
}

export function parseInitArgs(args: string[]): ParsedInitArgs {
  const out: ParsedInitArgs = { managedDb: false, unknown: [] };

  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    const take = (): string | undefined => args[++i];

    if (a === "--env") out.env = take();
    else if (a.startsWith("--env=")) out.env = a.slice("--env=".length);
    else if (a === "--provider") out.provider = take();
    else if (a.startsWith("--provider="))
      out.provider = a.slice("--provider=".length);
    else if (a === "--repo") out.repo = take();
    else if (a.startsWith("--repo=")) out.repo = a.slice("--repo=".length);
    else if (a === "--image-tag") out.imageTag = take();
    else if (a.startsWith("--image-tag="))
      out.imageTag = a.slice("--image-tag=".length);
    else if (a === "--managed-db") out.managedDb = true;
    else if (a === "--region") out.region = take();
    else if (a.startsWith("--region="))
      out.region = a.slice("--region=".length);
    else if (a === "--from-step") {
      const raw = take();
      const n = raw !== undefined ? parseInt(raw, 10) : NaN;
      if (!isNaN(n) && n >= 1 && n <= 6) out.fromStep = n;
      else out.unknown.push(`--from-step=${raw ?? ""}`);
    } else if (a.startsWith("--from-step=")) {
      const raw = a.slice("--from-step=".length);
      const n = parseInt(raw, 10);
      if (!isNaN(n) && n >= 1 && n <= 6) out.fromStep = n;
      else out.unknown.push(a);
    } else {
      out.unknown.push(a);
    }

    i++;
  }
  return out;
}

const VALID_PROVIDERS: InitProvider[] = ["gcp", "aws", "digitalocean", "vultr"];

export async function initCommand(args: string[]): Promise<void> {
  const parsed = parseInitArgs(args);

  if (parsed.unknown.length > 0) {
    console.error(`error: unknown argument(s): ${parsed.unknown.join(" ")}`);
    console.error(USAGE);
    process.exit(1);
    return;
  }

  const missing: string[] = [];
  if (!parsed.env) missing.push("--env");
  if (!parsed.provider) missing.push("--provider");
  if (!parsed.repo) missing.push("--repo");
  if (!parsed.imageTag) missing.push("--image-tag");

  if (missing.length > 0) {
    console.error(`error: missing required flag(s): ${missing.join(", ")}`);
    console.error(USAGE);
    process.exit(1);
    return;
  }

  if (!VALID_PROVIDERS.includes(parsed.provider as InitProvider)) {
    console.error(
      `error: unknown provider "${parsed.provider}". Valid providers: ${VALID_PROVIDERS.join(", ")}`,
    );
    console.error(USAGE);
    process.exit(1);
    return;
  }

  try {
    const result = await init({
      env: parsed.env!,
      provider: parsed.provider as InitProvider,
      repo: parsed.repo!,
      imageTag: parsed.imageTag!,
      managedDb: parsed.managedDb,
      ...(parsed.region ? { region: parsed.region } : {}),
      ...(parsed.fromStep !== undefined ? { fromStep: parsed.fromStep } : {}),
    });
    console.log(`host:      ${result.host}`);
    console.log(`deployUrl: ${result.deployUrl}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`init failed: ${message}`);
    process.exit(1);
  }
}
