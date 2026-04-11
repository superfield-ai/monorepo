import * as fs from "node:fs";
import git from "isomorphic-git";
import type { Issue } from "@superfield/github";
import { buildPrePRSelfAuditPrompt } from "../prompts/pre-pr-self-audit.ts";
import { runLLMTask, type LLMTaskOpts } from "../llm-task.ts";
import { pickCandidateDomains } from "../blueprint.ts";
import type { BlueprintViolation } from "./blueprint-conformance.ts";

/**
 * Pre-PR blueprint self-audit (issue #81).
 *
 * Inserted between dev-loop stage 3 ("checklist complete") and stage 4
 * ("PR open"). The agent is asked to read its own diff against the full
 * blueprint context for the issue's candidate domains and emit a verdict.
 *
 * On `conformant: true` the dev-loop opens the PR. On `conformant: false`
 * the dev-loop loops back to develop with the violations as remediation
 * instructions. Remediation is capped at 3 passes per issue (the cap is
 * enforced in the dev-loop, not here).
 */

export type PrePRSelfAuditViolation = BlueprintViolation;

export interface PrePRSelfAuditResult {
  conformant: boolean;
  violations: PrePRSelfAuditViolation[];
  diffSummary: string;
}

export interface PrePRSelfAuditOpts {
  issue: Issue;
  /** Absolute path to the worktree to audit. */
  repoPath: string;
  /** Violations carried over from the previous remediation round. */
  previousViolations?: PrePRSelfAuditViolation[];
  /** Spawn function for the LLM task. */
  spawn?: LLMTaskOpts["spawn"];
  /** Pre-computed diff summary (testing seam). */
  diffSummary?: string;
  /** Pre-computed candidate domains (testing seam). */
  candidateDomains?: string[];
}

interface RawVerdict {
  conformant?: unknown;
  violations?: unknown;
}

interface RawViolation {
  rule_id?: unknown;
  rule_name?: unknown;
  rule_type?: unknown;
  domain?: unknown;
  concern?: unknown;
}

export async function runPrePRSelfAudit(
  opts: PrePRSelfAuditOpts,
): Promise<PrePRSelfAuditResult> {
  const candidateDomains =
    opts.candidateDomains ??
    pickCandidateDomains({
      title: opts.issue.title,
      body: opts.issue.body ?? null,
      labels: opts.issue.labels ?? [],
    });

  const diffSummary =
    opts.diffSummary ?? (await summarizeWorktreeChanges(opts.repoPath));

  const prompt = buildPrePRSelfAuditPrompt({
    issueNumber: opts.issue.number,
    issueTitle: opts.issue.title,
    issueBody: opts.issue.body ?? "",
    candidateDomains,
    diffSummary,
    previousViolations: opts.previousViolations,
  });

  const { result } = await runLLMTask<{
    conformant: boolean;
    violations: PrePRSelfAuditViolation[];
  }>({ prompt, spawn: opts.spawn, cwd: opts.repoPath, model: "sonnet", loop: "dev" }, (json) => {
    const parsed = JSON.parse(json) as RawVerdict;
    if (typeof parsed.conformant !== "boolean") {
      throw new Error("missing boolean `conformant` field");
    }
    const rawViolations = Array.isArray(parsed.violations)
      ? (parsed.violations as RawViolation[])
      : [];
    const violations: PrePRSelfAuditViolation[] = rawViolations.map((v) => ({
      rule_id: typeof v.rule_id === "string" ? v.rule_id : "",
      rule_name: typeof v.rule_name === "string" ? v.rule_name : "",
      rule_type: typeof v.rule_type === "string" ? v.rule_type : "",
      domain: typeof v.domain === "string" ? v.domain : "",
      concern: typeof v.concern === "string" ? v.concern : "",
    }));
    if (parsed.conformant === false && violations.length === 0) {
      throw new Error("conformant=false but no violations were emitted");
    }
    return { conformant: parsed.conformant, violations };
  });

  return {
    conformant: result.conformant,
    violations: result.violations,
    diffSummary,
  };
}

/**
 * Produce a one-line-per-changed-file summary of the working tree using
 * isomorphic-git's status matrix. We deliberately avoid shelling out to
 * `git` — the worktree manager already pins the toolchain to
 * isomorphic-git so the dev-loop has zero binary dependencies.
 *
 * The status matrix shape is `[filepath, head, workdir, stage]`:
 *   - head=0 + workdir=2  → added
 *   - head=1 + workdir=0  → deleted
 *   - head=1 + workdir=2  → modified
 *   - any other non-(1,1,1) row is also a change worth reporting
 */
export async function summarizeWorktreeChanges(
  repoPath: string,
): Promise<string> {
  let matrix: Awaited<ReturnType<typeof git.statusMatrix>>;
  try {
    matrix = await git.statusMatrix({ fs, dir: repoPath });
  } catch (err) {
    return `(diff summary unavailable: ${err instanceof Error ? err.message : String(err)})`;
  }

  const lines: string[] = [];
  for (const row of matrix) {
    const [file, head, workdir] = row;
    if (head === 1 && workdir === 1) continue; // unchanged
    let status: string;
    if (head === 0 && workdir === 2) status = "added";
    else if (head === 1 && workdir === 0) status = "deleted";
    else if (head === 1 && workdir === 2) status = "modified";
    else status = "changed";
    lines.push(`- ${status}: ${file}`);
  }

  if (lines.length === 0) return "(no changes detected)";
  return lines.join("\n");
}
