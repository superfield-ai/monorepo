import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

import { GitHubApiError, githubRequest } from "../github/http.ts";
import { openPullRequest } from "../github/pull-request.ts";
import { makeDefaultGithubDeps } from "../github/index.ts";
import type { GitHubHttpDeps, PullRequestFile } from "../github/types.ts";

const TEMPLATE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "templates",
  "workflows",
);

const WORKFLOWS = ["release", "deploy", "rollback"] as const;
type WorkflowName = (typeof WORKFLOWS)[number];

export interface SyncWorkflowsOptions {
  repo: string;
  appName: string;
  imageRepo?: string;
  deployments?: string[];
  base?: string;
  /** Override timestamp source for deterministic tests. */
  now?: () => number;
  deps?: GitHubHttpDeps;
}

export interface SyncWorkflowsResult {
  prUrl?: string;
  changed: string[];
  unchanged: string[];
}

interface ContentItem {
  type: string;
  sha: string;
  content?: string;
  encoding?: string;
}

/**
 * Render the vendored workflow templates and, if any of the resulting files
 * differ (whitespace-insensitively) from what's currently in the target repo's
 * default branch, open a PR with the updated set.
 */
export async function syncWorkflows(
  opts: SyncWorkflowsOptions,
): Promise<SyncWorkflowsResult> {
  const deps = opts.deps ?? makeDefaultGithubDeps();
  const base = opts.base ?? "main";
  const imageRepo = opts.imageRepo ?? `ghcr.io/${opts.repo}`;
  const deployments =
    opts.deployments && opts.deployments.length > 0
      ? opts.deployments
      : [opts.appName];

  const substitutions = {
    APP_NAME: opts.appName,
    IMAGE_REPO: imageRepo,
    DEPLOYMENTS: deployments.join(","),
  };

  const rendered: Array<{ name: WorkflowName; path: string; content: string }> =
    [];
  for (const name of WORKFLOWS) {
    const tpl = await loadTemplate(name);
    rendered.push({
      name,
      path: `.github/workflows/${name}.yml`,
      content: substitute(tpl, substitutions),
    });
  }

  const changed: string[] = [];
  const unchanged: string[] = [];
  const filesToWrite: PullRequestFile[] = [];

  for (const file of rendered) {
    const existing = await getFileContent(opts.repo, file.path, base, deps);
    if (
      existing !== null &&
      normalizeWhitespace(existing) === normalizeWhitespace(file.content)
    ) {
      unchanged.push(file.path);
      continue;
    }
    changed.push(file.path);
    filesToWrite.push({ path: file.path, content: file.content });
  }

  if (filesToWrite.length === 0) {
    return { changed, unchanged };
  }

  const ts = Math.floor((opts.now ? opts.now() : Date.now()) / 1000);
  const branch = `superfield/sync-${ts}`;
  const title = "chore(superfield): sync workflow templates";
  const body = [
    "Sync vendored superfield workflow templates.",
    "",
    "Changed files:",
    ...changed.map((p) => `- \`${p}\``),
    ...(unchanged.length > 0
      ? ["", "Unchanged:", ...unchanged.map((p) => `- \`${p}\``)]
      : []),
  ].join("\n");

  const pr = await openPullRequest(opts.repo, branch, base, title, body, deps, {
    files: filesToWrite,
    commitMessage: title,
  });

  return { prUrl: pr.url, changed, unchanged };
}

export function substitute(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/\{\{\s*([A-Z_]+)\s*\}\}/g, (match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      return values[key] ?? match;
    }
    return match;
  });
}

export function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

async function loadTemplate(name: WorkflowName): Promise<string> {
  const file = path.join(TEMPLATE_DIR, `${name}.yml.tpl`);
  return readFile(file, "utf8");
}

async function getFileContent(
  repo: string,
  filePath: string,
  ref: string,
  deps: GitHubHttpDeps,
): Promise<string | null> {
  try {
    const { data } = await githubRequest<ContentItem>(
      `/repos/${repo}/contents/${encodeURI(filePath)}?ref=${encodeURIComponent(ref)}`,
      { method: "GET" },
      deps,
    );
    if (!data || Array.isArray(data) || !data.content) return null;
    if (data.encoding && data.encoding !== "base64") return null;
    return Buffer.from(data.content, "base64").toString("utf8");
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}
