import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  GitHubClientPort as GitHubClient,
  PullRequest,
} from "@superfield/github";
import {
  buildDocCoveragePrompt,
  buildDocCanonicalSyncPrompt,
  buildDocConsistencyPrompt,
} from "../prompts/index.ts";
import { runLLMTask, type LLMTaskOpts } from "../llm-task.ts";
import { runSupervisedLoop } from "../supervised-loop.ts";
import { formatError } from "../format-error.ts";

/**
 * The documentation loop. Triggered on every merge to `main`. Runs three
 * advisory tasks (coverage scan, canonical sync, consistency check) and
 * opens a single doc PR if any produced changes.
 *
 * See PRD §Command: start §Documentation loop.
 */

export interface DocLoopOpts {
  client: GitHubClient;
  owner: string;
  repo: string;
  /** Local checkout path used for reading current PRD/README/source files. */
  repoPath: string;
  spawn?: LLMTaskOpts["spawn"];
  /** Poll interval in ms between checks for newly merged PRs. Default 60_000. */
  pollIntervalMs?: number;
}

export interface DocCoverageMissing {
  file: string;
  symbol: string;
  kind: string;
  line: number;
}

export interface DocPatch {
  section?: string;
  old_text: string;
  new_text: string;
}

export interface DocSyncProposal {
  significant: boolean;
  rationale?: string;
  prd_patches: DocPatch[];
  readme_patches: DocPatch[];
}

export interface DocConsistencyFinding {
  level: "canonical" | "module" | "inline";
  path: string;
  section?: string;
  concern: string;
  ground_truth_source: string;
  fix_text_old: string;
  fix_text_new: string;
}

export interface DocLoopTickResult {
  pr: number | null;
  /** True if no merged PRs need processing. */
  idle: boolean;
  /** True when the tick actually ran because main changed. */
  triggered: boolean;
  /** The observed head SHA for this tick. */
  headSha: string;
  coverageMissing: DocCoverageMissing[];
  canonicalSync: DocSyncProposal | null;
  consistencyFindings: DocConsistencyFinding[];
  /** PR number opened with the doc changes, or null if no changes were applied. */
  docPrNumber: number | null;
}

const DEFAULT_POLL_MS = 60_000;

/**
 * Runs the doc loop forever. Tracks the last-processed merge timestamp
 * in memory; on restart, only processes PRs merged after the process started.
 */
export async function runDocLoop(opts: DocLoopOpts): Promise<void> {
  console.log("[doc] loop started");
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  let lastSeenSha: string | null = null;
  await runSupervisedLoop({
    runOnce: async () => {
      console.log("[doc] tick start");
      const headSha = await opts.client.getHeadSha(opts.owner, opts.repo);
      const result = await tickDocLoop({ ...opts, lastSeenSha, headSha });
      if (!result.triggered) {
        console.log(
          "[doc] tick idle: no new merged PRs on main",
        );
      } else if (result.docPrNumber) {
        console.log(
          `[doc] tick: processed PR #${result.pr}, opened doc PR #${result.docPrNumber}`,
        );
      } else {
        console.log(
          `[doc] tick: processed PR #${result.pr}, no doc changes required`,
        );
      }
      if (result.triggered) {
        lastSeenSha = headSha;
      }
      return result;
    },
    delayMs: () => pollMs,
    onError: (err) => {
      console.error(
        `[error] [doc] loop failed: ${formatError(err)}`,
      );
    },
  });
}

export interface DocLoopTickOpts extends DocLoopOpts {
  /** The last observed main SHA. If unchanged, the tick is skipped. */
  lastSeenSha?: string | null;
  /** Current main SHA when already known by the caller. */
  headSha?: string;
}

/** One iteration of the doc loop. Exported for testing. */
export async function tickDocLoop(
  opts: DocLoopTickOpts,
): Promise<DocLoopTickResult> {
  const { client, owner, repo } = opts;
  const headSha = opts.headSha ?? (await client.getHeadSha(owner, repo));
  const lastSeenSha = opts.lastSeenSha ?? null;

  if (lastSeenSha !== null && headSha === lastSeenSha) {
    return {
      pr: null,
      idle: true,
      triggered: false,
      headSha,
      coverageMissing: [],
      canonicalSync: null,
      consistencyFindings: [],
      docPrNumber: null,
    };
  }

  // 1. Find the most-recently merged PR
  const merged = await client.listMergedPullRequests(owner, repo);
  const candidate = pickMergedDocCandidate(merged);
  if (!candidate) {
    return {
      pr: null,
      idle: true,
      triggered: false,
      headSha,
      coverageMissing: [],
      canonicalSync: null,
      consistencyFindings: [],
      docPrNumber: null,
    };
  }

  // 2. Fetch changed files
  const changedFiles = await client.listPullRequestFiles(
    owner,
    repo,
    candidate.number,
  );
  const sourceFiles = filterDocSourceFiles(changedFiles);

  // 3. Run the three doc tasks in order: coverage scan → canonical sync →
  //    consistency check, as specified in PRD §Documentation loop.
  //    Canonical sync and consistency require at least one canonical doc
  //    (docs/prd.md or README.md) to be present. Skip both gracefully when
  //    neither exists — an LLM call with zero canonical content is useless.
  const hasPrd = await fileExists(opts.repoPath, "docs/prd.md");
  const hasReadme = await fileExists(opts.repoPath, "README.md");
  const hasCanonicalDocs = hasPrd || hasReadme;

  const coverageResult = await runCoverageScan(
    opts,
    candidate.number,
    sourceFiles,
  );
  const canonicalResult = hasCanonicalDocs
    ? await runCanonicalSync(opts, candidate, changedFiles)
    : null;
  const consistencyResult = hasCanonicalDocs
    ? await runConsistencyCheck(opts, sourceFiles)
    : [];

  const hasChanges =
    (canonicalResult?.prd_patches.length ?? 0) > 0 ||
    (canonicalResult?.readme_patches.length ?? 0) > 0 ||
    consistencyResult.length > 0;

  let docPrNumber: number | null = null;
  if (hasChanges && canonicalResult) {
    docPrNumber = await openDocPR(
      opts,
      candidate,
      canonicalResult,
      consistencyResult,
    );
  }

  return {
    pr: candidate.number,
    idle: false,
    triggered: true,
    headSha,
    coverageMissing: coverageResult,
    canonicalSync: canonicalResult,
    consistencyFindings: consistencyResult,
    docPrNumber,
  };
}

/**
 * Returns the most recently merged PR from the list, or null if the list is
 * empty. Trigger decisions are handled upstream via SHA comparison.
 */
export function pickMergedDocCandidate(
  merged: PullRequest[],
): PullRequest | null {
  return merged[0] ?? null;
}

export function filterDocSourceFiles(changedFiles: string[]): string[] {
  return changedFiles.filter(
    (file) =>
      /\.tsx?$/.test(file) &&
      !file.includes("/tests/") &&
      !file.endsWith(".test.ts"),
  );
}

async function runCoverageScan(
  opts: DocLoopOpts,
  prNumber: number,
  sourceFiles: string[],
): Promise<DocCoverageMissing[]> {
  if (sourceFiles.length === 0) return [];
  const prompt = buildDocCoveragePrompt({
    prNumber,
    changedFiles: sourceFiles,
  });
  const { result } = await runLLMTask<{ missing_docs: DocCoverageMissing[] }>(
    { prompt, spawn: opts.spawn, cwd: opts.repoPath, model: "sonnet", loop: "doc", jobType: "doc-coverage" },
    (json) => {
      const parsed = JSON.parse(json) as {
        missing_docs?: DocCoverageMissing[];
      };
      return { missing_docs: parsed.missing_docs ?? [] };
    },
  );
  return result.missing_docs;
}

async function runCanonicalSync(
  opts: DocLoopOpts,
  pr: PullRequest,
  changedFiles: string[],
): Promise<DocSyncProposal> {
  const prdContent = await readIfExists(opts.repoPath, "docs/prd.md");
  const readmeContent = await readIfExists(opts.repoPath, "README.md");
  const prompt = buildDocCanonicalSyncPrompt({
    prNumber: pr.number,
    prTitle: pr.title,
    prBody: pr.body ?? "",
    changedFiles,
    prdContent: prdContent ?? "",
    readmeContent: readmeContent ?? "",
  });
  const { result } = await runLLMTask<DocSyncProposal>(
    { prompt, spawn: opts.spawn, cwd: opts.repoPath, model: "sonnet", loop: "doc", jobType: "doc-canonical-sync" },
    (json) => {
      const parsed = JSON.parse(json) as Partial<DocSyncProposal>;
      return {
        significant: parsed.significant ?? false,
        rationale: parsed.rationale,
        prd_patches: parsed.prd_patches ?? [],
        readme_patches: parsed.readme_patches ?? [],
      };
    },
  );
  return result;
}

async function runConsistencyCheck(
  opts: DocLoopOpts,
  sourceFiles: string[],
): Promise<DocConsistencyFinding[]> {
  if (sourceFiles.length === 0) return [];
  // Read a sample of canonical/module/inline docs from disk
  const canonicalSnippets = await collectCanonicalSnippets(opts.repoPath);
  const moduleSnippets: Array<{ path: string; content: string }> = [];
  const inlineSnippets = await collectInlineSnippets(
    opts.repoPath,
    sourceFiles,
  );

  const prompt = buildDocConsistencyPrompt({
    canonicalSnippets,
    moduleSnippets,
    inlineSnippets,
  });
  const { result } = await runLLMTask<{
    inconsistencies: DocConsistencyFinding[];
  }>({ prompt, spawn: opts.spawn, cwd: opts.repoPath, model: "sonnet", loop: "doc", jobType: "doc-consistency" }, (json) => {
    const parsed = JSON.parse(json) as {
      inconsistencies?: DocConsistencyFinding[];
    };
    return { inconsistencies: parsed.inconsistencies ?? [] };
  });
  return result.inconsistencies;
}

async function readIfExists(
  repoPath: string,
  relPath: string,
): Promise<string | null> {
  try {
    return await fs.readFile(path.join(repoPath, relPath), "utf8");
  } catch {
    return null;
  }
}

async function fileExists(repoPath: string, relPath: string): Promise<boolean> {
  try {
    await fs.access(path.join(repoPath, relPath));
    return true;
  } catch {
    return false;
  }
}

async function collectCanonicalSnippets(
  repoPath: string,
): Promise<Array<{ path: string; content: string }>> {
  const snippets: Array<{ path: string; content: string }> = [];
  for (const rel of ["docs/prd.md", "README.md"]) {
    const content = await readIfExists(repoPath, rel);
    if (content) snippets.push({ path: rel, content: content.slice(0, 4000) });
  }
  return snippets;
}

async function collectInlineSnippets(
  repoPath: string,
  files: string[],
): Promise<Array<{ path: string; symbol: string; content: string }>> {
  const snippets: Array<{ path: string; symbol: string; content: string }> = [];
  for (const file of files.slice(0, 5)) {
    const full = await readIfExists(repoPath, file);
    if (!full) continue;
    snippets.push({
      path: file,
      symbol: "(file)",
      content: full.slice(0, 2000),
    });
  }
  return snippets;
}

/**
 * Creates a doc PR with all proposed patches. Each patch is committed to a
 * fresh `docs/auto-N` branch via the GitHub Contents API.
 */
async function openDocPR(
  opts: DocLoopOpts,
  triggeringPR: PullRequest,
  sync: DocSyncProposal,
  consistency: DocConsistencyFinding[],
): Promise<number | null> {
  const { client, owner, repo } = opts;

  const branch = `docs/auto-${triggeringPR.number}-${Date.now()}`;

  // Create the branch from main
  const main = await client.getHeadSha(owner, repo, "main");
  await client.createBranch(owner, repo, branch, main);

  let changesApplied = 0;

  // Apply PRD patches
  for (const patch of sync.prd_patches) {
    if (
      await applyPatchToFile(client, owner, repo, branch, "docs/prd.md", patch)
    ) {
      changesApplied++;
    }
  }

  // Apply README patches
  for (const patch of sync.readme_patches) {
    if (
      await applyPatchToFile(client, owner, repo, branch, "README.md", patch)
    ) {
      changesApplied++;
    }
  }

  // Apply consistency findings (each fixes one file)
  for (const finding of consistency) {
    const filePath = finding.path;
    const docPatch: DocPatch = {
      section: finding.section,
      old_text: finding.fix_text_old,
      new_text: finding.fix_text_new,
    };
    if (
      await applyPatchToFile(client, owner, repo, branch, filePath, docPatch)
    ) {
      changesApplied++;
    }
  }

  if (changesApplied === 0) return null;

  const body = [
    `Automated documentation PR triggered by #${triggeringPR.number}.`,
    "",
    sync.rationale ? `**Canonical sync rationale:** ${sync.rationale}` : "",
    "",
    `${sync.prd_patches.length} PRD patches, ${sync.readme_patches.length} README patches, ${consistency.length} consistency fixes applied.`,
    "",
    `Closes nothing — doc-only PR. CI is skipped (paths gating).`,
  ]
    .filter(Boolean)
    .join("\n");

  const pr = await client.createPullRequest({
    owner,
    repo,
    title: `docs: auto-sync after #${triggeringPR.number}`,
    head: branch,
    base: "main",
    body,
  });

  return pr.number;
}

async function applyPatchToFile(
  client: GitHubClient,
  owner: string,
  repo: string,
  branch: string,
  filePath: string,
  patch: DocPatch,
): Promise<boolean> {
  const current = await client.getFileContents(owner, repo, filePath, branch);
  if (!current) return false;
  if (!current.content.includes(patch.old_text)) return false;
  const updated = current.content.replace(patch.old_text, patch.new_text);
  if (updated === current.content) return false;
  await client.putFileContents({
    owner,
    repo,
    path: filePath,
    branch,
    message: `docs(${filePath}): auto-sync${patch.section ? ` ${patch.section}` : ""}`,
    content: updated,
    sha: current.sha,
  });
  return true;
}
