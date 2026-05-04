import * as path from "node:path";
import { runAudit } from "@superfield/core";
import { CAPABILITIES } from "@superfield/core";

const VALID_CAPABILITY_IDS = CAPABILITIES.map((c) => c.id);

const USAGE = `Usage: superfield audit --path <repo-path>
                      [--repo <owner/name>] [--capabilities <id,...>]
                      [--output-dir <dir>] [--no-issues] [--force]

Options:
  --path <dir>              Absolute or relative path to the app repo on disk  [required]
  --repo <owner/name>       GitHub repo to open gap issues on (skipped if omitted)
  --capabilities <id,...>   Comma-separated capability IDs to check (default: all)
  --output-dir <dir>        Where to write JSON findings (default: <path>/.superfield/audit)
  --no-issues               Analyse only — do not open GitHub issues
  --force, -f               Re-run all capabilities even if findings are newer than HEAD

Capabilities: ${VALID_CAPABILITY_IDS.join(", ")}`;

export interface ParsedAuditArgs {
  repoPath?: string;
  repo?: string;
  capabilities?: string[];
  outputDir?: string;
  noIssues: boolean;
  force: boolean;
  unknown: string[];
}

export function parseAuditArgs(args: string[]): ParsedAuditArgs {
  const out: ParsedAuditArgs = { noIssues: false, force: false, unknown: [] };

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

    if (a === "--path") out.repoPath = take();
    else if ((v = eq("--path=")) !== undefined) out.repoPath = v;
    else if (a === "--repo") out.repo = take();
    else if ((v = eq("--repo=")) !== undefined) out.repo = v;
    else if (a === "--output-dir") out.outputDir = take();
    else if ((v = eq("--output-dir=")) !== undefined) out.outputDir = v;
    else if (a === "--capabilities") {
      const cv = take();
      out.capabilities = cv
        ? cv
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
    } else if ((v = eq("--capabilities=")) !== undefined) {
      out.capabilities = v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === "--no-issues") out.noIssues = true;
    else if (a === "--force" || a === "-f") out.force = true;
    else out.unknown.push(a);

    i++;
  }

  return out;
}

export async function auditCommand(args: string[]): Promise<void> {
  const parsed = parseAuditArgs(args);

  if (parsed.unknown.length > 0) {
    console.error(`error: unknown argument(s): ${parsed.unknown.join(" ")}`);
    console.error(USAGE);
    process.exit(1);
    return;
  }

  if (!parsed.repoPath) {
    console.error("error: --path is required");
    console.error(USAGE);
    process.exit(1);
    return;
  }

  const invalidCaps = (parsed.capabilities ?? []).filter(
    (id) => !VALID_CAPABILITY_IDS.includes(id),
  );
  if (invalidCaps.length > 0) {
    console.error(
      `error: unknown capability ID(s): ${invalidCaps.join(", ")}\n` +
        `Valid IDs: ${VALID_CAPABILITY_IDS.join(", ")}`,
    );
    process.exit(1);
    return;
  }

  const repoPath = path.resolve(parsed.repoPath);

  try {
    const summary = await runAudit({
      repoPath,
      repo: parsed.repo,
      outputDir: parsed.outputDir,
      capabilities: parsed.capabilities,
      noIssues: parsed.noIssues,
      force: parsed.force,
    });

    console.log(`\naudit complete`);
    console.log(`output: ${summary.outputDir}`);
    if (summary.conformant.length > 0) {
      console.log(`  conformant:     ${summary.conformant.join(", ")}`);
    }
    if (summary.nonConformant.length > 0) {
      console.log(`  gaps found:     ${summary.nonConformant.join(", ")}`);
    }
    if (summary.absent.length > 0) {
      console.log(`  absent:         ${summary.absent.join(", ")}`);
    }
    const issueCount = Object.keys(summary.issueUrls).length;
    if (issueCount > 0) {
      console.log(`  issues opened:  ${issueCount}`);
      for (const [id, url] of Object.entries(summary.issueUrls)) {
        console.log(`    ${id}: ${url}`);
      }
    }

    const hasGaps =
      summary.nonConformant.length > 0 || summary.absent.length > 0;
    process.exitCode = hasGaps ? 1 : 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`audit failed: ${message}`);
    process.exit(1);
  }
}
