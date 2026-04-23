import * as path from "node:path";
import { runAudit } from "@superfield/core";
import { CAPABILITIES } from "@superfield/core";

const VALID_CAPABILITY_IDS = CAPABILITIES.map((c) => c.id);

const USAGE = `Usage: superfield audit --path <repo-path>
                      [--repo <owner/name>] [--capabilities <id,...>]
                      [--output-dir <dir>] [--no-issues]

Options:
  --path <dir>              Absolute or relative path to the app repo on disk  [required]
  --repo <owner/name>       GitHub repo to open gap issues on (skipped if omitted)
  --capabilities <id,...>   Comma-separated capability IDs to check (default: all)
  --output-dir <dir>        Where to write JSON findings (default: <path>/.superfield/audit)
  --no-issues               Analyse only — do not open GitHub issues

Capabilities: ${VALID_CAPABILITY_IDS.join(", ")}`;

export interface ParsedAuditArgs {
  repoPath?: string;
  repo?: string;
  capabilities?: string[];
  outputDir?: string;
  noIssues: boolean;
  unknown: string[];
}

export function parseAuditArgs(args: string[]): ParsedAuditArgs {
  const out: ParsedAuditArgs = { noIssues: false, unknown: [] };

  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    const take = (): string | undefined => args[++i];
    const eq = (prefix: string): string | null =>
      a.startsWith(prefix) ? a.slice(prefix.length) : null;

    if (a === "--path") out.repoPath = take();
    else if (eq("--path=") !== null) out.repoPath = eq("--path=")!;
    else if (a === "--repo") out.repo = take();
    else if (eq("--repo=") !== null) out.repo = eq("--repo=")!;
    else if (a === "--output-dir") out.outputDir = take();
    else if (eq("--output-dir=") !== null) out.outputDir = eq("--output-dir=")!;
    else if (a === "--capabilities") {
      const v = take();
      out.capabilities = v
        ? v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
    } else if (eq("--capabilities=") !== null) {
      const v = eq("--capabilities=")!;
      out.capabilities = v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === "--no-issues") out.noIssues = true;
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
