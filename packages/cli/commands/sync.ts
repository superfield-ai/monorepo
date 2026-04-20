import { syncWorkflows } from "@superfield/core";

const USAGE = [
  "Usage:",
  "  superfield sync --repo <owner/name> --app-name <name>",
  "                  [--image-repo <repo>] [--deployments <a,b,c>]",
].join("\n");

export interface ParsedSyncArgs {
  repo?: string;
  appName?: string;
  imageRepo?: string;
  deployments?: string[];
  unknown: string[];
}

export function parseSyncArgs(args: string[]): ParsedSyncArgs {
  let repo: string | undefined;
  let appName: string | undefined;
  let imageRepo: string | undefined;
  let deployments: string[] | undefined;
  const unknown: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const [k, vInline] = splitFlag(arg);
    const take = (): string | undefined =>
      vInline !== undefined ? vInline : args[++i];

    switch (k) {
      case "--repo":
        repo = take();
        break;
      case "--app-name":
        appName = take();
        break;
      case "--image-repo":
        imageRepo = take();
        break;
      case "--deployments": {
        const v = take();
        deployments = v
          ? v
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0)
          : [];
        break;
      }
      default:
        unknown.push(arg);
    }
  }

  return { repo, appName, imageRepo, deployments, unknown };
}

function splitFlag(arg: string): [string, string | undefined] {
  const eq = arg.indexOf("=");
  if (arg.startsWith("--") && eq > 0) {
    return [arg.slice(0, eq), arg.slice(eq + 1)];
  }
  return [arg, undefined];
}

export async function syncCommand(args: string[]): Promise<void> {
  const parsed = parseSyncArgs(args);

  if (parsed.unknown.length > 0 || !parsed.repo || !parsed.appName) {
    console.error(USAGE);
    process.exit(1);
    return;
  }

  if (!/^[^/\s]+\/[^/\s]+$/.test(parsed.repo)) {
    console.error(
      `error: --repo must be in owner/name form (got ${parsed.repo})`,
    );
    process.exit(1);
    return;
  }

  try {
    const result = await syncWorkflows({
      repo: parsed.repo,
      appName: parsed.appName,
      ...(parsed.imageRepo ? { imageRepo: parsed.imageRepo } : {}),
      ...(parsed.deployments ? { deployments: parsed.deployments } : {}),
    });

    if (result.prUrl) {
      console.log(`\u2713 Opened workflow sync PR: ${result.prUrl}`);
      for (const p of result.changed) console.log(`  changed: ${p}`);
      for (const p of result.unchanged) console.log(`  unchanged: ${p}`);
    } else {
      console.log("\u2713 Workflows already up to date; no PR opened");
      for (const p of result.unchanged) console.log(`  unchanged: ${p}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`error: ${message}`);
    process.exit(1);
  }
}
