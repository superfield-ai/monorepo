import type { GitHubClient, Issue } from '@superfield/github';
import { WorktreeManager, type IssueWorktree } from '@superfield/git';
import { parsePlan, type PlanIssueMetadata, type Plan } from '../plan.ts';
import {
  buildDevelopIssuePrompt,
  buildDevScoutPrompt,
  buildCIFailurePrompt,
} from '../prompts/index.ts';
import { spawnAgent, type AgentOpts, type AgentResult } from '../agent.ts';
import { getSession, upsertSession, deleteSession } from '../sessions.ts';

/**
 * The dev loop — drives one primary issue at a time through the 7-stage
 * lifecycle until merged. Speculative slots are added in Phase 8.
 *
 * See PRD §Command: start §Dev loop.
 */

export interface DevLoopOpts {
  client: GitHubClient;
  owner: string;
  repo: string;
  /** Auth token (used for git clone in worktree manager). */
  token: string;
  worktrees?: WorktreeManager;
  spawn?: (opts: AgentOpts) => Promise<AgentResult>;
  /** How often to poll the Plan when no work is available. Default 30s. */
  idlePollMs?: number;
}

export interface DevLoopTickResult {
  /** Issue number worked, or null if no work was available. */
  primaryIssue: number | null;
  /** True if the issue closed during this tick (success). */
  closed: boolean;
  /** True if no primary candidate exists (all done or all blocked). */
  idle: boolean;
  reason?: string;
}

const DEFAULT_IDLE_MS = 30_000;

/**
 * Runs the dev loop forever. Selects the top-of-Plan issue, prepares its
 * worktree, spawns the agent, and waits for it to exit. Resumes any
 * existing session via the deadman switch.
 */
export async function runDevLoop(opts: DevLoopOpts): Promise<void> {
  const idleMs = opts.idlePollMs ?? DEFAULT_IDLE_MS;
  while (true) {
    const result = await tickDevLoop(opts);
    if (result.idle) {
      await sleep(idleMs);
    }
  }
}

/** One iteration of the dev loop. Exported for testing. */
export async function tickDevLoop(opts: DevLoopOpts): Promise<DevLoopTickResult> {
  const { client, owner, repo } = opts;

  // 1. Read the Plan
  const planIssues = await client.listIssues(owner, repo, ['plan']);
  if (planIssues.length === 0) {
    return { primaryIssue: null, closed: false, idle: true, reason: 'no Plan issue exists' };
  }
  const plan = parsePlan(planIssues[0]!.body ?? '');

  // 2. Select primary
  const primaryEntry = await selectPrimary(client, owner, repo, plan);
  if (!primaryEntry) {
    return { primaryIssue: null, closed: false, idle: true, reason: 'no eligible primary' };
  }

  // 3. Fetch the full issue body
  const issue = await client.getIssue(owner, repo, primaryEntry.number);
  if (issue.state === 'closed') {
    // Issue was closed externally — clean up the session and try the next tick
    await deleteSession(client, owner, repo, issue.number);
    return { primaryIssue: issue.number, closed: true, idle: false };
  }

  // 4. Prep worktree
  const worktrees = opts.worktrees ?? new WorktreeManager();
  const branch = branchForIssue(primaryEntry);
  const slug = slugFromTitle(primaryEntry.title);
  const wt = await worktrees.create({
    owner,
    repo,
    issueNumber: primaryEntry.number,
    slug,
    branch,
    token: opts.token,
  });

  // 5. Resume or start fresh
  const existing = await getSession(client, owner, repo, primaryEntry.number);
  const sessionId = existing?.session.sessionId;

  // 6. Build prompt for the right kind
  const prompt = buildPromptForKind(primaryEntry, issue, branch, wt, plan);

  // 7. Claim the slot (write deadman switch BEFORE spawning)
  await upsertSession(client, owner, repo, primaryEntry.number, {
    sessionId: sessionId ?? 'pending',
    role: 'primary',
    slot: 1,
    startedAt: new Date().toISOString(),
  });

  // 8. Spawn the agent
  const spawn = opts.spawn ?? spawnAgent;
  const agentResult = await spawn({
    prompt,
    worktreePath: wt.path,
    sessionId,
  });

  // 9. Update session with the real session ID (in case this was a fresh spawn)
  await upsertSession(client, owner, repo, primaryEntry.number, {
    sessionId: agentResult.sessionId,
    role: 'primary',
    slot: 1,
    startedAt: existing?.session.startedAt ?? new Date().toISOString(),
  });

  // 10. Check if the issue closed
  const updatedIssue = await client.getIssue(owner, repo, primaryEntry.number);
  if (updatedIssue.state === 'closed') {
    await deleteSession(client, owner, repo, primaryEntry.number);
    return { primaryIssue: primaryEntry.number, closed: true, idle: false };
  }

  // Agent exited but issue is still open — do not clear session, will retry
  return { primaryIssue: primaryEntry.number, closed: false, idle: false };
}

/**
 * Selects the next primary issue from the Plan. CI failures are always
 * processed first; then phase issues in order. An issue is eligible only
 * if all its dependencies are CLOSED on the forge.
 */
async function selectPrimary(
  client: GitHubClient,
  owner: string,
  repo: string,
  plan: Plan,
): Promise<PlanIssueMetadata | null> {
  // CI failures take absolute priority
  for (const entry of plan.ciFailures) {
    if (await isEligible(client, owner, repo, entry)) {
      return entry;
    }
  }
  for (const phase of plan.phases) {
    for (const entry of phase.issues) {
      if (await isEligible(client, owner, repo, entry)) {
        return entry;
      }
    }
  }
  return null;
}

async function isEligible(
  client: GitHubClient,
  owner: string,
  repo: string,
  entry: PlanIssueMetadata,
): Promise<boolean> {
  const issue = await client.getIssue(owner, repo, entry.number);
  if (issue.state === 'closed') return false;
  return predecessorsClosed(client, owner, repo, entry);
}

async function predecessorsClosed(
  client: GitHubClient,
  owner: string,
  repo: string,
  entry: PlanIssueMetadata,
): Promise<boolean> {
  if (entry.dependencies.length === 0) return true;
  for (const depNumber of entry.dependencies) {
    const dep = await client.getIssue(owner, repo, depNumber);
    if (dep.state !== 'closed') return false;
  }
  return true;
}

function branchForIssue(entry: PlanIssueMetadata): string {
  const slug = slugFromTitle(entry.title);
  const prefix =
    entry.kind === 'dev-scout' ? 'chore' : entry.kind === 'ci-failure' ? 'fix' : 'feat';
  return `${prefix}/${entry.number}-${slug}`;
}

function slugFromTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^[a-z]+:\s*/, '') // strip conventional prefix
    .replace(/\[.*?\]\s*/g, '') // strip [dev-scout] tags
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function buildPromptForKind(
  entry: PlanIssueMetadata,
  issue: Issue,
  branch: string,
  wt: IssueWorktree,
  plan: Plan,
): string {
  if (entry.kind === 'ci-failure') {
    // Pull check info from issue body if present (canonical_docs section
    // contains the check run URL by convention)
    return buildCIFailurePrompt({
      issue,
      checkName: extractCheckName(entry.title),
      checkRunUrl: extractCheckUrl(issue.body),
      sha: extractSha(entry.title),
      worktreePath: wt.path,
      branch,
    });
  }

  if (entry.kind === 'dev-scout') {
    // Find downstream features in the same phase
    const phase = plan.phases.find((p) => p.name === entry.phase);
    return buildDevScoutPrompt({
      scoutIssue: issue,
      worktreePath: wt.path,
      branch,
      phaseName: entry.phase,
      phaseGoal: phase?.goal ?? '',
      featureIssues: [],  // Phase 7 doesn't fetch sibling bodies; Phase 8 will
    });
  }

  return buildDevelopIssuePrompt({
    issue,
    role: 'primary',
    worktreePath: wt.path,
    branch,
    phaseName: entry.phase,
  });
}

function extractCheckName(title: string): string {
  // "fix(repo): test:unit failed on main @ abc1234" → "test:unit"
  const match = /:\s*(.+?)\s+failed/.exec(title);
  return match?.[1] ?? 'unknown';
}

function extractSha(title: string): string {
  const match = /@\s*([a-f0-9]+)/.exec(title);
  return match?.[1] ?? '';
}

function extractCheckUrl(body: string | null): string {
  if (!body) return '';
  const match = /(https:\/\/github\.com\/[^\s)]+\/runs\/\d+)/.exec(body);
  return match?.[1] ?? '';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
