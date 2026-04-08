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
  /** Total slot count (1 primary + N-1 speculative). Default 3. */
  slotCount?: number;
}

export interface DevLoopTickResult {
  /** Issue number worked, or null if no work was available. */
  primaryIssue: number | null;
  /** Speculative issue numbers worked in this tick. */
  speculativeIssues: number[];
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
    return { primaryIssue: null, speculativeIssues: [], closed: false, idle: true, reason: 'no Plan issue exists' };
  }
  const plan = parsePlan(planIssues[0]!.body ?? '');

  // 2. Select primary
  const primaryEntry = await selectPrimary(client, owner, repo, plan);
  if (!primaryEntry) {
    return { primaryIssue: null, speculativeIssues: [], closed: false, idle: true, reason: 'no eligible primary' };
  }

  // 3. Select speculative candidates (only if scout is merged for the primary's phase)
  const slotCount = Math.max(1, opts.slotCount ?? 3);
  const speculative = await selectSpeculative(
    client,
    owner,
    repo,
    plan,
    primaryEntry,
    slotCount - 1,
  );

  // 4. Run primary slot to completion + speculative slots in parallel
  const primaryPromise = runSlot(opts, plan, primaryEntry, 'primary', 1);
  const speculativePromises = speculative.map((entry, idx) =>
    runSlot(opts, plan, entry, 'speculative', idx + 2),
  );

  const [primaryResult] = await Promise.all([primaryPromise, ...speculativePromises]);

  return {
    primaryIssue: primaryEntry.number,
    speculativeIssues: speculative.map((e) => e.number),
    closed: primaryResult.closed,
    idle: false,
  };
}

/**
 * Runs one slot end-to-end: prep worktree, claim session, spawn agent,
 * update session, detect close.
 */
async function runSlot(
  opts: DevLoopOpts,
  plan: Plan,
  entry: PlanIssueMetadata,
  role: 'primary' | 'speculative',
  slot: number,
): Promise<{ closed: boolean }> {
  const { client, owner, repo } = opts;

  const issue = await client.getIssue(owner, repo, entry.number);
  if (issue.state === 'closed') {
    await deleteSession(client, owner, repo, issue.number);
    return { closed: true };
  }

  const worktrees = opts.worktrees ?? new WorktreeManager();
  const branch = branchForIssue(entry);
  const slug = slugFromTitle(entry.title);
  const wt = await worktrees.create({
    owner,
    repo,
    issueNumber: entry.number,
    slug,
    branch,
    token: opts.token,
  });

  const existing = await getSession(client, owner, repo, entry.number);
  const sessionId = existing?.session.sessionId;

  const prompt = buildPromptForKind(entry, issue, branch, wt, plan, role);

  await upsertSession(client, owner, repo, entry.number, {
    sessionId: sessionId ?? 'pending',
    role,
    slot,
    startedAt: new Date().toISOString(),
  });

  const spawn = opts.spawn ?? spawnAgent;
  const agentResult = await spawn({
    prompt,
    worktreePath: wt.path,
    sessionId,
  });

  await upsertSession(client, owner, repo, entry.number, {
    sessionId: agentResult.sessionId,
    role,
    slot,
    startedAt: existing?.session.startedAt ?? new Date().toISOString(),
  });

  // Speculative agents exit when their checklist is complete; the issue
  // does NOT close until the primary later opens and merges the PR. So we
  // only check close on the primary slot.
  if (role === 'primary') {
    const updatedIssue = await client.getIssue(owner, repo, entry.number);
    if (updatedIssue.state === 'closed') {
      await deleteSession(client, owner, repo, entry.number);
      return { closed: true };
    }
  }

  return { closed: false };
}

/**
 * Selects up to `count` speculative candidates from the same phase as the
 * primary. Speculative slots only open if the phase scout is CLOSED on `main`.
 */
async function selectSpeculative(
  client: GitHubClient,
  owner: string,
  repo: string,
  plan: Plan,
  primary: PlanIssueMetadata,
  count: number,
): Promise<PlanIssueMetadata[]> {
  if (count <= 0) return [];
  if (primary.kind === 'ci-failure') return []; // CI failures are never paired

  const phase = plan.phases.find((p) => p.name === primary.phase);
  if (!phase) return [];
  if (phase.scoutGate === null) return [];

  // Scout gate: scout must be CLOSED
  const scoutIssue = await client.getIssue(owner, repo, phase.scoutGate);
  if (scoutIssue.state !== 'closed') return [];

  const candidates: PlanIssueMetadata[] = [];
  for (const entry of phase.issues) {
    if (candidates.length >= count) break;
    if (entry.number === primary.number) continue;
    if (entry.kind === 'dev-scout') continue;
    if (await isEligible(client, owner, repo, entry)) {
      candidates.push(entry);
    }
  }
  return candidates;
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
  role: 'primary' | 'speculative',
): string {
  if (entry.kind === 'ci-failure') {
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
    const phase = plan.phases.find((p) => p.name === entry.phase);
    return buildDevScoutPrompt({
      scoutIssue: issue,
      worktreePath: wt.path,
      branch,
      phaseName: entry.phase,
      phaseGoal: phase?.goal ?? '',
      featureIssues: [],
    });
  }

  return buildDevelopIssuePrompt({
    issue,
    role,
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
