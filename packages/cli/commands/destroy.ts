import { destroy } from "@superfield/core";
import type { Provider } from "@superfield/core";

const USAGE = `Usage: superfield destroy --env <env> --provider <gcp|aws|digitalocean|vultr> --repo <owner/name>
                [--yes] [--yes-i-really-mean-it]`;

export interface ParsedDestroyArgs {
  env?: string;
  provider?: string;
  repo?: string;
  yes: boolean;
  yesIReallyMeanIt: boolean;
  unknown: string[];
}

export function parseDestroyArgs(args: string[]): ParsedDestroyArgs {
  let env: string | undefined;
  let provider: string | undefined;
  let repo: string | undefined;
  let yes = false;
  let yesIReallyMeanIt = false;
  const unknown: string[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === undefined) {
      i++;
      continue;
    }
    if (arg === "--env") {
      env = args[++i];
    } else if (arg.startsWith("--env=")) {
      env = arg.slice("--env=".length);
    } else if (arg === "--provider") {
      provider = args[++i];
    } else if (arg.startsWith("--provider=")) {
      provider = arg.slice("--provider=".length);
    } else if (arg === "--repo") {
      repo = args[++i];
    } else if (arg.startsWith("--repo=")) {
      repo = arg.slice("--repo=".length);
    } else if (arg === "--yes" || arg === "-y") {
      yes = true;
    } else if (arg === "--yes-i-really-mean-it") {
      yesIReallyMeanIt = true;
    } else if (arg.startsWith("--")) {
      unknown.push(arg);
    } else {
      unknown.push(arg);
    }
    i++;
  }

  return { env, provider, repo, yes, yesIReallyMeanIt, unknown };
}

const VALID_PROVIDERS = new Set<string>([
  "gcp",
  "aws",
  "digitalocean",
  "vultr",
]);

export async function destroyCommand(args: string[]): Promise<void> {
  const parsed = parseDestroyArgs(args);

  if (parsed.unknown.length > 0) {
    console.error(`Unknown argument(s): ${parsed.unknown.join(" ")}`);
    console.error(USAGE);
    process.exit(1);
    return;
  }

  if (!parsed.env) {
    console.error("error: --env <env> is required");
    console.error(USAGE);
    process.exit(1);
    return;
  }

  if (!parsed.provider) {
    console.error("error: --provider <gcp|aws|digitalocean|vultr> is required");
    console.error(USAGE);
    process.exit(1);
    return;
  }

  if (!VALID_PROVIDERS.has(parsed.provider)) {
    console.error(
      `error: unknown provider "${parsed.provider}". Must be one of: gcp, aws, digitalocean, vultr`,
    );
    console.error(USAGE);
    process.exit(1);
    return;
  }

  if (!parsed.repo) {
    console.error("error: --repo <owner/name> is required");
    console.error(USAGE);
    process.exit(1);
    return;
  }

  await destroy({
    env: parsed.env,
    provider: parsed.provider as Provider,
    repo: parsed.repo,
    yes: parsed.yes,
    yesIReallyMeanIt: parsed.yesIReallyMeanIt,
  });
}
