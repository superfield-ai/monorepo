import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { spawnAgent } from "../agent.ts";
import { githubRequest } from "../github/http.ts";
import { makeDefaultGithubDeps } from "../github/index.ts";
import type { GitHubHttpDeps } from "../github/types.ts";
import { CAPABILITIES, type AuditCapability } from "../audit/capabilities.ts";
import { buildAuditCapabilityPrompt } from "../prompts/audit.ts";

// ── Public types ──────────────────────────────────────────────────────────────

export interface CapabilityFinding {
  capabilityId: string;
  present: boolean;
  conformant: boolean;
  gaps: string[];
  evidence: string[];
  summary: string;
  sessionId?: string;
  costUsd?: number;
  /** ISO timestamp added when the finding is persisted; absent on raw agent output. */
  checkedAt?: string;
}

export interface AuditSummary {
  repoPath: string;
  outputDir: string;
  capabilities: string[];
  conformant: string[];
  nonConformant: string[];
  absent: string[];
  issueUrls: Record<string, string>;
  completedAt: string;
}

export interface AuditOpts {
  /** Absolute path to the application repo on disk. */
  repoPath: string;
  /** GitHub repo in owner/name form — required to open issues. */
  repo?: string;
  /** Directory to write JSON findings. Defaults to <repoPath>/.superfield/audit */
  outputDir?: string;
  /** Restrict audit to these capability IDs. Defaults to all. */
  capabilities?: string[];
  /** Skip GitHub issue creation even when gaps are found. */
  noIssues?: boolean;
  /** Dependency injection for tests. */
  deps?: AuditDeps;
}

export interface AuditDeps {
  spawnAgent?: typeof spawnAgent;
  createIssue?: (
    repo: string,
    title: string,
    body: string,
    githubDeps: GitHubHttpDeps,
  ) => Promise<{ url: string; number: number }>;
  writeFile?: (filePath: string, content: string) => Promise<void>;
  readFile?: (filePath: string) => Promise<string | null>;
  mkdir?: (dirPath: string) => Promise<void>;
  onLog?: (line: string) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(deps: AuditDeps | undefined, line: string): void {
  (deps?.onLog ?? ((l) => process.stdout.write(`${l}\n`)))(line);
}

/**
 * Extract a JSON object from agent output. Prefers a ```json ... ``` code
 * fence; falls back to treating the entire trimmed output as JSON.
 */
function extractFinding(text: string): CapabilityFinding | null {
  const fenceMatch = text.match(/```json\s*([\s\S]*?)```/);
  const candidate = fenceMatch?.[1] ?? text.trim();
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    if (
      typeof parsed.capabilityId === "string" &&
      typeof parsed.present === "boolean" &&
      typeof parsed.conformant === "boolean" &&
      Array.isArray(parsed.gaps) &&
      Array.isArray(parsed.evidence) &&
      typeof parsed.summary === "string"
    ) {
      return {
        capabilityId: parsed.capabilityId,
        present: parsed.present,
        conformant: parsed.conformant,
        gaps: parsed.gaps as string[],
        evidence: parsed.evidence as string[],
        summary: parsed.summary,
      };
    }
  } catch {
    // fall through
  }
  return null;
}

function buildIssueBody(
  capability: AuditCapability,
  finding: CapabilityFinding,
): string {
  const gapChecklist = finding.gaps.map((g) => `- [ ] ${g}`).join("\n");
  const evidenceList =
    finding.evidence.length > 0
      ? finding.evidence.map((e) => `- ${e}`).join("\n")
      : "- (none found)";

  const canonicalDocs =
    capability.blueprintRuleIds && capability.blueprintRuleIds.length > 0
      ? capability.blueprintRuleIds
          .map((id) => `- Blueprint rule \`${id}\``)
          .join("\n")
      : "- Superfield blueprint";

  const testPlan = [
    `- [ ] ${capability.name} is reachable via the normal application flow`,
    `- [ ] All gaps listed in Features are resolved`,
    `- [ ] Automated tests cover the new implementation`,
  ].join("\n");

  return [
    `## Phase\nBacklog`,
    `## Motivation\n${finding.summary}`,
    `## Canonical docs\n${canonicalDocs}`,
    `## Context\n**Evidence found:**\n${evidenceList}`,
    `## Features\n${gapChecklist}`,
    `## Test Plan\n${testPlan}`,
  ].join("\n\n");
}

async function createIssueDefault(
  repo: string,
  title: string,
  body: string,
  githubDeps: GitHubHttpDeps,
): Promise<{ url: string; number: number }> {
  const [owner, repoName] = repo.split("/");
  const { data } = await githubRequest<{ html_url: string; number: number }>(
    `/repos/${owner}/${repoName}/issues`,
    {
      method: "POST",
      jsonBody: { title, body },
    },
    githubDeps,
  );
  if (!data)
    throw new Error("github: failed to create issue (no response body)");
  return { url: data.html_url, number: data.number };
}

// ── Concurrency helpers ───────────────────────────────────────────────────────

const AUDIT_CONCURRENCY = 5;

/**
 * Run `fn` over every item in `items`, with at most `concurrency` items
 * in-flight at once. Order of completion is not guaranteed.
 */
async function withConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (queue.length > 0) {
        const item = queue.shift()!;
        await fn(item);
      }
    },
  );
  await Promise.all(workers);
}

// ── Core function ─────────────────────────────────────────────────────────────

export async function runAudit(opts: AuditOpts): Promise<AuditSummary> {
  const deps = opts.deps ?? {};
  const outputDir =
    opts.outputDir ?? path.join(opts.repoPath, ".superfield", "audit");

  const mkdirFn =
    deps.mkdir ?? ((p) => mkdir(p, { recursive: true }).then(() => undefined));
  const writeFn = deps.writeFile ?? ((p, c) => writeFile(p, c, "utf8"));
  const readFn =
    deps.readFile ??
    (async (p) => {
      try {
        return await readFile(p, "utf8");
      } catch {
        return null;
      }
    });

  await mkdirFn(outputDir);

  const requestedCaps = opts.capabilities;
  const capsToRun = requestedCaps
    ? CAPABILITIES.filter((c) => requestedCaps.includes(c.id))
    : CAPABILITIES;

  if (capsToRun.length === 0) {
    throw new Error(
      `No capabilities matched. Available: ${CAPABILITIES.map((c) => c.id).join(", ")}`,
    );
  }

  const spawnFn = deps.spawnAgent ?? spawnAgent;
  const createIssueFn = deps.createIssue ?? createIssueDefault;
  const githubDeps = makeDefaultGithubDeps();

  const issueUrls: Record<string, string> = {};
  const findings: CapabilityFinding[] = [];

  // Mutex: serialize finding pushes and disk writes so concurrent workers
  // don't interleave writes to the shared arrays/objects.
  let writeLock = Promise.resolve();
  const enqueueWrite = (fn: () => Promise<void>): Promise<void> => {
    writeLock = writeLock.then(fn);
    return writeLock;
  };

  await withConcurrency(capsToRun, AUDIT_CONCURRENCY, async (cap) => {
    const findingPath = path.join(outputDir, `${cap.id}.json`);

    // Resume: skip if a complete finding already exists on disk.
    const existing = await readFn(findingPath);
    if (existing) {
      try {
        const parsed = JSON.parse(existing) as CapabilityFinding;
        if (typeof parsed.conformant === "boolean") {
          log(deps, `[audit] skip ${cap.id} — finding already on disk`);
          await enqueueWrite(async () => {
            findings.push(parsed);
          });
          return;
        }
      } catch {
        // corrupted file — re-run
      }
    }

    log(deps, `[audit] checking: ${cap.name}`);

    const prompt = buildAuditCapabilityPrompt({ capability: cap });

    let agentResult;
    try {
      agentResult = await spawnFn({
        worktreePath: opts.repoPath,
        prompt,
        jobType: "audit",
        task: cap.name,
        loop: "audit",
        maxTurns: 100,
      });
    } catch (err) {
      log(
        deps,
        `[audit] agent threw for ${cap.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    if (agentResult.isError) {
      log(deps, `[audit] agent error for ${cap.id}: ${agentResult.output}`);
      return;
    }

    const finding = extractFinding(agentResult.output);
    if (!finding) {
      log(
        deps,
        `[audit] could not parse finding for ${cap.id} — raw output saved`,
      );
      await writeFn(
        path.join(outputDir, `${cap.id}.raw.txt`),
        agentResult.output,
      );
      return;
    }

    const fullFinding: CapabilityFinding = {
      ...finding,
      sessionId: agentResult.sessionId,
      costUsd: agentResult.costUsd,
      checkedAt: new Date().toISOString(),
    };

    log(
      deps,
      `[audit] ${cap.id}: present=${finding.present} conformant=${finding.conformant} gaps=${finding.gaps.length}`,
    );

    // Serialize disk write + shared-state mutation to avoid interleaving.
    await enqueueWrite(async () => {
      await writeFn(findingPath, JSON.stringify(fullFinding, null, 2));
      findings.push(fullFinding);
    });

    // Open a GitHub issue for each capability gap (outside the write lock —
    // network I/O is independent of shared state).
    if (!finding.conformant && !opts.noIssues && opts.repo) {
      const title = `feat: ${cap.name}`;
      const body = buildIssueBody(cap, finding);
      try {
        const issue = await createIssueFn(opts.repo, title, body, githubDeps);
        await enqueueWrite(async () => {
          issueUrls[cap.id] = issue.url;
        });
        log(
          deps,
          `[audit] opened issue #${issue.number} for ${cap.id}: ${issue.url}`,
        );
      } catch (err) {
        log(
          deps,
          `[audit] failed to open issue for ${cap.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  });

  const summary: AuditSummary = {
    repoPath: opts.repoPath,
    outputDir,
    capabilities: findings.map((f) => f.capabilityId),
    conformant: findings.filter((f) => f.conformant).map((f) => f.capabilityId),
    nonConformant: findings
      .filter((f) => f.present && !f.conformant)
      .map((f) => f.capabilityId),
    absent: findings.filter((f) => !f.present).map((f) => f.capabilityId),
    issueUrls,
    completedAt: new Date().toISOString(),
  };

  await writeFn(
    path.join(outputDir, "summary.json"),
    JSON.stringify(summary, null, 2),
  );

  return summary;
}
