import * as fs from "node:fs/promises";
import { join } from "node:path";
import type {
  GitHubClientPort as GitHubClient,
  Issue,
} from "@superfield/github";
import { WorktreeManager, type IssueWorktree } from "@superfield/git";
import {
  parsePlan,
  planIssueOrder,
  type PlanIssueMetadata,
  type Plan,
} from "../plan.ts";
import { defaultSleep } from "../retry.ts";
import {
  buildDevelopIssuePrompt,
  buildDevScoutPrompt,
  buildCIFailurePrompt,
} from "../prompts/index.ts";
import {
  spawnAgent,
  StaleSessionError,
  type AgentOpts,
  type AgentResult,
} from "../agent.ts";
import { writeToLog } from "../file-logger.ts";
import { type LogLevel, LOG_LEVEL_RANK, resolveLogLevel } from "../logger.ts";
import {
  classifyStartupSessions,
  getSession,
  upsertSession,
  deleteSession,
} from "../sessions.ts";
import { withRetry, CircuitBreaker } from "../retry.ts";
import {
  runPrePRSelfAudit,
  type PrePRSelfAuditResult,
} from "../steps/pre-pr-self-audit.ts";
import type { BlueprintViolation } from "../steps/blueprint-conformance.ts";
import { formatError } from "../format-error.ts";
import type { ApiState } from "../api-state.ts";

/** Cap on remediation passes per issue (#81). */
export const SELF_AUDIT_REMEDIATION_CAP = 3;

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
  /** Sessions older than this are considered stale. Default 4h. */
  staleSessionTimeoutMs?: number;
  /** Wall-clock interval between periodic prune passes. Default 15min. */
  pruneIntervalMs?: number;
  /**
   * Circuit breaker shared across all slots. If omitted, a default instance
   * (trips at 5 consecutive failures, 5min reset) is created internally.
   */
  circuit?: CircuitBreaker;
  /** @internal Test seam — override the prune function used by runDevLoop. */
  _pruneFn?: (opts: DevLoopOpts) => Promise<PruneResult>;
  /** @internal Test seam — signal slot workers to exit cleanly. */
  _abortSignal?: AbortSignal;
  /** @internal Used by tickDevLoop tests to inject a pre-loaded plan issue. */
  startupPlanIssue?: Issue;
  /** @internal Used by tickDevLoop tests to inject prioritized issue numbers. */
  startupPrioritizedIssueNumbers?: number[];
  /** @internal Used by tickDevLoop tests to inject reaped session numbers. */
  startupReapedSessions?: number[];
  /** Optional shared API state for analytics and steering. */
  apiState?: ApiState;
}

export interface PruneResult {
  /** Issue numbers whose worktrees were deleted. */
  prunedWorktrees: number[];
  /** Issue numbers whose stale session comments were deleted. */
  reapedSessions: number[];
}

export interface DevLoopTickResult {
  /** Issue number worked, or null if no work was available. */
  primaryIssue: number | null;
  /** Speculative issue numbers worked in this tick. */
  speculativeIssues: number[];
  /** Issues blocked by an earlier plan predecessor. */
  mergeGateBlocked: number[];
  /** Startup/session scan seam for future session recovery work. */
  reapedSessions: number[];
  /** True if the issue closed during this tick (success). */
  closed: boolean;
  /** True if no primary candidate exists (all done or all blocked). */
  idle: boolean;
  reason?: string;
}

class FatalDevLoopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalDevLoopError";
  }
}

const DEFAULT_IDLE_MS = 30_000;
const DEFAULT_PRUNE_INTERVAL_MS = 15 * 60 * 1000;

function devLog(level: LogLevel, message: string, slot?: number): void {
  const scope = slot !== undefined ? `[dev ${slot}]` : "[dev]";
  const line = `[${level}] ${scope} ${message}`;
  writeToLog(line);
  if (level === "error") return console.error(line);
  if (level === "warn") return console.warn(line);
  const current = resolveLogLevel();
  if (LOG_LEVEL_RANK[level] <= LOG_LEVEL_RANK[current]) {
    console.log(line);
  }
}

/**
 * Runs the dev loop forever. Selects the top-of-Plan issue, prepares its
 * worktree, spawns the agent, and waits for it to exit. Resumes any
 * existing session via the deadman switch.
 */
export async function runDevLoop(opts: DevLoopOpts): Promise<void> {
  console.log("[dev] loop started");
  const startupPlan = await findOpenPlanIssue(
    opts.client,
    opts.owner,
    opts.repo,
  );
  if (!startupPlan) {
    throw new FatalDevLoopError(
      `No open Plan issue found for ${opts.owner}/${opts.repo}. Run 'superfield plan <repo-path>' before 'superfield start'.`,
    );
  }
  console.log(
    `[dev] plan issue ready: #${startupPlan.number} ${startupPlan.title}`,
  );
  const idleMs = opts.idlePollMs ?? DEFAULT_IDLE_MS;
  const pruneIntervalMs = opts.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
  const pruneFn = opts._pruneFn ?? runPrunePass;
  const circuit =
    opts.circuit ?? new CircuitBreaker({ tripAt: 5, resetMs: 5 * 60 * 1000 });
  const optsWithCircuit: DevLoopOpts = { ...opts, circuit };

  let startupHandoff: {
    prioritizedIssueNumbers: number[];
    reapedSessions: number[];
  } = { prioritizedIssueNumbers: [], reapedSessions: [] };
  console.log("[dev] scanning existing sessions...");
  try {
    startupHandoff = await buildStartupSessionHandoff(opts, startupPlan);
    const { prioritizedIssueNumbers: p, reapedSessions: r } = startupHandoff;
    console.log(
      `[dev] session scan done: ${p.length} prioritized, ${r.length} stale reaped`,
    );
  } catch (err) {
    console.error(
      `[error] [dev] startup session scan failed: ${formatError(err)}`,
    );
  }
  console.log("[dev] running startup prune pass...");
  try {
    await pruneFn(opts);
  } catch (err) {
    console.error(
      `[error] [dev] startup prune pass failed: ${formatError(err)}`,
    );
  }

  const slotCount = Math.max(1, opts.slotCount ?? 3);
  // Shared across slots: prevents two slots from picking the same issue.
  const activeIssues = new Set<number>();
  // Serialises work-selection so slots don't race to claim the same entry.
  const selectionMutex = new SelectionMutex();
  // Shared prune timestamp — only one slot prunes at a time.
  const lastPruneAt = { value: Date.now() };
  // Circuit state tracking for analytics (updated by slot 1 only).
  const prevCircuitOpen = { value: circuit.isOpen };

  await Promise.all(
    Array.from({ length: slotCount }, (_, i) =>
      runSlotWorker({
        slot: i + 1,
        opts: optsWithCircuit,
        circuit,
        activeIssues,
        selectionMutex,
        pruneFn,
        idleMs,
        pruneIntervalMs,
        lastPruneAt,
        prevCircuitOpen,
        startupPlan,
        startupPrioritizedIssueNumbers:
          i === 0 ? startupHandoff.prioritizedIssueNumbers : [],
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Slot-worker model
// ---------------------------------------------------------------------------

/**
 * Serialises work-selection across concurrent slot workers so two slots
 * cannot race to claim the same issue. Once a slot adds an entry to
 * `activeIssues` inside the mutex, subsequent slots skip it.
 */
class SelectionMutex {
  private chain = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn);
    // Keep the chain moving even if fn throws.
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

interface SlotWorkerCtx {
  slot: number;
  opts: DevLoopOpts;
  circuit: CircuitBreaker;
  /** Issue numbers currently being worked by some slot. */
  activeIssues: Set<number>;
  selectionMutex: SelectionMutex;
  pruneFn: (opts: DevLoopOpts) => Promise<PruneResult>;
  idleMs: number;
  pruneIntervalMs: number;
  /** Shared mutable ref — prevents concurrent prune runs across slots. */
  lastPruneAt: { value: number };
  /** Shared mutable ref — used by slot 1 to track circuit state for analytics. */
  prevCircuitOpen: { value: boolean };
  /** Pre-loaded plan issue used for first selection only. */
  startupPlan: Issue;
  /** Issue numbers from session scan used for first selection only (slot 1). */
  startupPrioritizedIssueNumbers: number[];
}

/**
 * Runs one slot forever: select work → run it → select again.
 * Only re-checks for work after the current task finishes, so no unnecessary
 * polling happens while all slots are busy.
 */
async function runSlotWorker(ctx: SlotWorkerCtx): Promise<void> {
  const {
    slot,
    opts,
    circuit,
    activeIssues,
    selectionMutex,
    pruneFn,
    idleMs,
    pruneIntervalMs,
    lastPruneAt,
    prevCircuitOpen,
  } = ctx;

  let isFirstSelection = true;
  let errorDelayMs = 1_000;
  const MAX_ERROR_DELAY_MS = 30_000;

  while (!opts._abortSignal?.aborted) {
    // Track circuit state changes for analytics (slot 1 only).
    if (slot === 1) {
      const nowOpen = circuit.isOpen;
      if (!prevCircuitOpen.value && nowOpen) {
        opts.apiState?.recordCircuitTripped(circuit.consecutiveFailures);
      } else if (prevCircuitOpen.value && !nowOpen) {
        opts.apiState?.recordCircuitReset();
      }
      prevCircuitOpen.value = nowOpen;
    }

    // Select work — serialised so slots don't race to pick the same issue.
    let work: {
      plan: Plan;
      entry: PlanIssueMetadata;
      role: "primary" | "speculative";
      blocked: number[];
    } | null = null;

    try {
      work = await selectionMutex.run(() =>
        selectWorkForSlot(
          opts,
          activeIssues,
          isFirstSelection ? ctx.startupPlan : undefined,
          isFirstSelection ? ctx.startupPrioritizedIssueNumbers : [],
        ),
      );
      isFirstSelection = false;
      errorDelayMs = 1_000;
    } catch (err) {
      if (err instanceof FatalDevLoopError) throw err;
      console.error(`[error] [dev] loop failed: ${formatError(err)}`);
      await defaultSleep(errorDelayMs);
      errorDelayMs = Math.min(errorDelayMs * 2, MAX_ERROR_DELAY_MS);
      continue;
    }

    if (!work) {
      opts.apiState?.recordLoopTick("dev", 0, "idle");
      // Only slot 1 logs idle and runs prune, to avoid duplicate output.
      if (slot === 1) {
        console.log(`[dev] idle — next check in ${idleMs / 1000}s`);
        try {
          await pruneFn(opts);
          lastPruneAt.value = Date.now();
        } catch (err) {
          console.error(`[error] [dev] prune pass failed: ${formatError(err)}`);
        }
      }
      await defaultSleep(idleMs);
      continue;
    }

    // Run the slot to completion — no re-check happens until it finishes.
    const tickStartMs = Date.now();
    try {
      await runSlot(opts, work.plan, work.entry, work.role, slot);
      errorDelayMs = 1_000;
    } catch (err) {
      if (err instanceof FatalDevLoopError) throw err;
      console.error(`[error] [dev] loop failed: ${formatError(err)}`);
      await defaultSleep(errorDelayMs);
      errorDelayMs = Math.min(errorDelayMs * 2, MAX_ERROR_DELAY_MS);
    } finally {
      activeIssues.delete(work.entry.number);
    }

    opts.apiState?.recordLoopTick("dev", Date.now() - tickStartMs);

    // Wall-clock prune after each completed slot (slot 1 only, on interval).
    if (slot === 1 && Date.now() - lastPruneAt.value >= pruneIntervalMs) {
      try {
        await pruneFn(opts);
        lastPruneAt.value = Date.now();
      } catch (err) {
        console.error(
          `[error] [dev] periodic prune pass failed: ${formatError(err)}`,
        );
      }
    }
  }
}

/**
 * Selects the next unit of work for a slot from the plan, skipping issues
 * already claimed by another slot. Adds the chosen entry to `activeIssues`
 * before returning so the caller holds the claim.
 * Returns null when no eligible work exists (idle).
 */
async function selectWorkForSlot(
  opts: DevLoopOpts,
  activeIssues: Set<number>,
  startupPlan?: Issue,
  startupPrioritizedIssueNumbers: number[] = [],
): Promise<{
  plan: Plan;
  entry: PlanIssueMetadata;
  role: "primary" | "speculative";
  blocked: number[];
} | null> {
  const { client, owner, repo } = opts;

  const planIssue =
    startupPlan ?? (await findOpenPlanIssue(client, owner, repo));
  if (!planIssue) return null;

  const plan = parsePlan(planIssue.body ?? "");
  const allPlanNumbers = [
    ...plan.ciFailures.map((e) => e.number),
    ...plan.phases.flatMap((p) => p.issues.map((e) => e.number)),
  ];
  devLog(
    "trace",
    `plan has ${plan.phases.length} phase(s), ${allPlanNumbers.length} issue(s) total`,
  );
  devLog("info", `prefetching ${allPlanNumbers.length} plan issue(s)...`);

  const issueCache = new Map<number, Issue>();
  await Promise.all(
    allPlanNumbers.map(async (n) => {
      try {
        issueCache.set(n, await client.getIssue(owner, repo, n));
      } catch {
        // leave uncached — selection helpers fall back to live fetch
      }
    }),
  );
  const cachedClient = withIssueCache(client, issueCache);

  // Startup: resume sessions from the pre-boot scan first.
  if (startupPrioritizedIssueNumbers.length > 0) {
    const startupEntry = await selectStartupPrimary(
      cachedClient,
      owner,
      repo,
      plan,
      startupPrioritizedIssueNumbers,
    );
    if (startupEntry && !activeIssues.has(startupEntry.number)) {
      const blocked = await collectMergeGateBlocked(
        cachedClient,
        owner,
        repo,
        plan,
        startupEntry.number,
      );
      devLog(
        "info",
        `picked primary issue #${startupEntry.number} kind=${startupEntry.kind} phase=${startupEntry.phase} (startup resume)`,
      );
      activeIssues.add(startupEntry.number);
      return { plan, entry: startupEntry, role: "primary", blocked };
    }
  }

  devLog("info", "selecting primary issue...");
  const { entry: primaryEntry, blocked } = await selectPrimary(
    cachedClient,
    owner,
    repo,
    plan,
  );

  if (primaryEntry && !activeIssues.has(primaryEntry.number)) {
    devLog(
      "info",
      `picked primary issue #${primaryEntry.number} kind=${primaryEntry.kind} phase=${primaryEntry.phase}`,
    );
    if (blocked.length > 0) {
      devLog(
        "debug",
        `current merge-gate blocked issues while picking primary: ${blocked.map((n) => `#${n}`).join(", ")}`,
      );
    }
    activeIssues.add(primaryEntry.number);
    return { plan, entry: primaryEntry, role: "primary", blocked };
  }

  // Primary is busy or unavailable — try a speculative candidate.
  if (primaryEntry) {
    const slotCount = Math.max(1, opts.slotCount ?? 3);
    const candidates = await selectSpeculative(
      cachedClient,
      owner,
      repo,
      plan,
      primaryEntry,
      slotCount - 1,
    );
    for (const candidate of candidates) {
      if (!activeIssues.has(candidate.number)) {
        devLog(
          "info",
          `picked speculative issue #${candidate.number} kind=${candidate.kind}`,
        );
        activeIssues.add(candidate.number);
        return { plan, entry: candidate, role: "speculative", blocked };
      }
    }
    devLog("debug", "no speculative issues picked for this slot");
  }

  if (blocked.length > 0) {
    devLog(
      "debug",
      `no work available — merge-gate blocked: ${blocked.map((n) => `#${n}`).join(", ")}`,
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// tickDevLoop — kept for unit tests; no longer used by runDevLoop
// ---------------------------------------------------------------------------

/** One iteration of the dev loop. Exported for testing. */
export async function tickDevLoop(
  opts: DevLoopOpts,
): Promise<DevLoopTickResult> {
  const { client, owner, repo } = opts;
  const startupReapedSessions = opts.startupReapedSessions ?? [];

  // 1. Read the Plan
  const planIssue =
    opts.startupPlanIssue ?? (await findOpenPlanIssue(client, owner, repo));
  if (!planIssue) {
    return {
      primaryIssue: null,
      speculativeIssues: [],
      mergeGateBlocked: [],
      reapedSessions: startupReapedSessions,
      closed: false,
      idle: true,
      reason: "no Plan issue exists",
    };
  }
  const plan = parsePlan(planIssue.body ?? "");
  const allPlanNumbers = [
    ...plan.ciFailures.map((e) => e.number),
    ...plan.phases.flatMap((p) => p.issues.map((e) => e.number)),
  ];
  devLog(
    "trace",
    `plan has ${plan.phases.length} phase(s), ${allPlanNumbers.length} issue(s) total`,
  );

  // 2. Prefetch all plan issue states in parallel so selection helpers don't
  //    make O(N²) sequential API calls.
  devLog("info", `prefetching ${allPlanNumbers.length} plan issue(s)...`);
  const issueCache = new Map<number, Issue>();
  await Promise.all(
    allPlanNumbers.map(async (n) => {
      try {
        const issue = await client.getIssue(owner, repo, n);
        issueCache.set(n, issue);
      } catch {
        // leave uncached — selection helpers will fall through to a live fetch
      }
    }),
  );
  const cachedClient = withIssueCache(client, issueCache);

  // 3. Select primary
  devLog("info", "selecting primary issue...");
  const startupEntry = await selectStartupPrimary(
    cachedClient,
    owner,
    repo,
    plan,
    opts.startupPrioritizedIssueNumbers ?? [],
  );
  const { entry: primaryEntry, blocked } = startupEntry
    ? {
        entry: startupEntry,
        blocked: await collectMergeGateBlocked(
          cachedClient,
          owner,
          repo,
          plan,
          startupEntry.number,
        ),
      }
    : await selectPrimary(cachedClient, owner, repo, plan);
  if (!primaryEntry) {
    const noPrimaryReason =
      blocked.length > 0
        ? "merge gate blocked"
        : await diagnoseNoPrimaryReason(cachedClient, owner, repo, plan);
    return {
      primaryIssue: null,
      speculativeIssues: [],
      mergeGateBlocked: blocked,
      reapedSessions: startupReapedSessions,
      closed: false,
      idle: true,
      reason: noPrimaryReason,
    };
  }
  devLog(
    "info",
    `picked primary issue #${primaryEntry.number} kind=${primaryEntry.kind} phase=${primaryEntry.phase}`,
  );
  if (blocked.length > 0) {
    devLog(
      "debug",
      `current merge-gate blocked issues while picking primary: ${blocked.map((n) => `#${n}`).join(", ")}`,
    );
  }

  // 4. Select speculative candidates (only if scout is merged for the primary's phase)
  const slotCount = Math.max(1, opts.slotCount ?? 3);
  const speculative = await selectSpeculative(
    cachedClient,
    owner,
    repo,
    plan,
    primaryEntry,
    slotCount - 1,
  );
  if (speculative.length > 0) {
    devLog(
      "info",
      `picked speculative issues: ${speculative.map((entry) => `#${entry.number}`).join(", ")}`,
    );
  } else {
    devLog("debug", "no speculative issues picked for this tick");
  }

  // 5. Run primary slot to completion + speculative slots in parallel
  const primaryPromise = runSlot(opts, plan, primaryEntry, "primary", 1);
  const speculativePromises = speculative.map((entry, idx) =>
    runSlot(opts, plan, entry, "speculative", idx + 2),
  );

  const [primaryResult] = await Promise.all([
    primaryPromise,
    ...speculativePromises,
  ]);

  return {
    primaryIssue: primaryEntry.number,
    speculativeIssues: speculative.map((e) => e.number),
    mergeGateBlocked: Array.from(
      new Set([...blocked, ...primaryResult.mergeGateBlocked]),
    ),
    reapedSessions: startupReapedSessions,
    closed: primaryResult.closed,
    idle: false,
  };
}

/** Context produced by prepareWorktreeAndSession for downstream stages. */
interface SlotContext {
  issue: Issue;
  wt: IssueWorktree;
  branch: string;
  sessionId: string | undefined;
  escalated: boolean;
  remediationCount: number;
  remediationViolations: BlueprintViolation[] | undefined;
  existingSession: Awaited<ReturnType<typeof getSession>>;
}

/** Check whether the remediation cap has been exceeded. */
function isRemediationCapExceeded(
  role: "primary" | "speculative",
  kind: string,
  remediationCount: number,
): boolean {
  return (
    role === "primary" &&
    kind === "feature" &&
    remediationCount >= SELF_AUDIT_REMEDIATION_CAP
  );
}

/**
 * Stage 1: worktree creation, session read, escalation latch read,
 * remediation state read, remediation cap pre-check.
 * Returns null if the issue is already closed or remediation cap exceeded.
 */
async function prepareWorktreeAndSession(
  opts: DevLoopOpts,
  entry: PlanIssueMetadata,
  role: "primary" | "speculative",
  slot: number,
): Promise<SlotContext | null> {
  const { client, owner, repo } = opts;
  devLog("info", `preparing issue #${entry.number} (${entry.kind})`, slot);

  const issue = await client.getIssue(owner, repo, entry.number);
  if (issue.state === "closed") {
    await deleteSession(client, owner, repo, issue.number);
    return null;
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
  // Only resume a session that has a real UUID (not the "pending" placeholder
  // written before the first spawn completes)
  const rawSessionId = existing?.session.sessionId;
  const sessionId =
    rawSessionId && /^[0-9a-f-]{36}$/i.test(rawSessionId)
      ? rawSessionId
      : undefined;
  if (sessionId && existing?.session.startedAt) {
    const ageMs = Date.now() - new Date(existing.session.startedAt).getTime();
    const ageMin = Math.round(ageMs / 60_000);
    devLog(
      "info",
      `issue #${entry.number} resuming session ${sessionId} started ${ageMin}m ago`,
      slot,
    );
  }
  devLog(
    "trace",
    `issue #${entry.number} worktree=${wt.path} branch=${branch} resume_session=${sessionId ?? "none"}`,
    slot,
  );

  // Escalation latch (#78): once an earlier turn returned
  // needsBlueprintEscalation, the session record carries blueprintEscalated,
  // and every subsequent prompt on this issue layers in principles + threats.
  const escalated = existing?.session.blueprintEscalated === true;

  // Pre-PR self-audit remediation state (#81).
  const remediationCount = existing?.session.selfAuditRemediationCount ?? 0;
  if (isRemediationCapExceeded(role, entry.kind, remediationCount)) {
    console.error(
      `[error] [dev] blueprint self-audit remediation cap exceeded for #${entry.number} — manual intervention required (${remediationCount}/${SELF_AUDIT_REMEDIATION_CAP} passes)`,
    );
    return null;
  }
  const remediationViolations = existing?.session.selfAuditPendingViolations;

  return {
    issue,
    wt,
    branch,
    sessionId,
    escalated,
    remediationCount,
    remediationViolations,
    existingSession: existing,
  };
}

/**
 * Stage 2: prompt building, agent spawn, post-spawn session update,
 * self-audit, remediation loopback decision.
 * Returns whether to proceed to merge gate (true) or loop back (false).
 */
async function executeAgentWithAudit(
  opts: DevLoopOpts,
  plan: Plan,
  entry: PlanIssueMetadata,
  role: "primary" | "speculative",
  slot: number,
  ctx: SlotContext,
): Promise<{ proceedToMerge: boolean }> {
  const { client, owner, repo } = opts;
  const {
    issue,
    wt,
    branch,
    sessionId,
    escalated,
    remediationCount,
    remediationViolations,
    existingSession: existing,
  } = ctx;

  const prompt = buildPromptForKind(
    entry,
    issue,
    branch,
    wt,
    plan,
    role,
    escalated,
    remediationViolations,
  );

  await upsertSession(client, owner, repo, entry.number, {
    sessionId: sessionId ?? "pending",
    role,
    slot,
    startedAt: new Date().toISOString(),
    blueprintEscalated: escalated || undefined,
    selfAuditRemediationCount: remediationCount || undefined,
    selfAuditPendingViolations: remediationViolations,
  });
  devLog("trace", `issue #${entry.number} session claimed role=${role}`, slot);

  const spawnFn = opts.spawn ?? spawnAgent;
  const circuit = opts.circuit;

  // Record agent start for API analytics
  const agentStartMs = Date.now();
  const pendingSessionId = sessionId ?? `pending-${slot}`;
  opts.apiState?.recordAgentStart({
    slot,
    issueNumber: entry.number,
    role,
    sessionId: pendingSessionId,
    backend: "claude",
    model: "sonnet",
    startedAt: new Date().toISOString(),
  });

  // Heartbeat interval: runs while the agent is alive (every 60s)
  let pendingSteeringContext: string | undefined;
  let nextEscalatedFromSteer = false;
  const heartbeatInterval = setInterval(() => {
    opts.apiState?.recordHeartbeat(slot, Date.now() - agentStartMs);
    // Consume steer if queued for this session
    const steer = opts.apiState?.consumeSteer(pendingSessionId);
    if (steer) {
      devLog(
        "info",
        `steering context received (requestId=${steer.requestId})`,
        slot,
      );
      pendingSteeringContext = steer.context;
    }
    // Consume escalation if queued for this issue
    const esc = opts.apiState?.consumeEscalation(entry.number);
    if (esc) {
      devLog(
        "info",
        `external escalation triggered (requestId=${esc.requestId})`,
        slot,
      );
      nextEscalatedFromSteer = true;
    }
  }, 60_000);

  let effectiveSessionId = sessionId;
  let agentResult: AgentResult;
  try {
    agentResult = await (async () => {
      try {
        return await withRetry(
          () => {
            const call = () =>
              spawnFn({
                prompt,
                worktreePath: wt.path,
                sessionId: effectiveSessionId,
                model: "sonnet",
                loop: "dev",
                task: entry.kind,
                jobType:
                  entry.kind === "dev-scout"
                    ? "dev-scout"
                    : entry.kind === "ci-failure"
                      ? "ci-failure"
                      : "dev",
              });
            return circuit ? circuit.call(call) : call();
          },
          { maxAttempts: 3, initialDelayMs: 2000, backoffFactor: 2 },
        );
      } catch (err) {
        if (err instanceof StaleSessionError) {
          devLog(
            "warn",
            `issue #${entry.number} stale session cleared — retrying as new session`,
            slot,
          );
          await deleteSession(client, owner, repo, entry.number);
          effectiveSessionId = undefined;
          return await spawnFn({
            prompt,
            worktreePath: wt.path,
            sessionId: undefined,
            model: "sonnet",
            loop: "dev",
            task: entry.kind,
            jobType:
              entry.kind === "dev-scout"
                ? "dev-scout"
                : entry.kind === "ci-failure"
                  ? "ci-failure"
                  : "dev",
          });
        }
        throw err;
      }
    })();
    clearInterval(heartbeatInterval);
    opts.apiState?.recordAgentEnd(
      slot,
      agentResult.costUsd ?? 0,
      "claude",
      agentResult.isError,
    );
  } catch (err) {
    clearInterval(heartbeatInterval);
    opts.apiState?.recordAgentEnd(slot, 0, "claude", true);
    throw err;
  }

  // Write pending steering context into the worktree for next invocation
  if (pendingSteeringContext) {
    try {
      const superfieldDir = join(wt.path, ".superfield");
      await fs.mkdir(superfieldDir, { recursive: true });
      await fs.writeFile(
        join(superfieldDir, "steer.md"),
        pendingSteeringContext,
        "utf8",
      );
    } catch {
      // best-effort: log but don't abort
    }
    pendingSteeringContext = undefined;
  }

  devLog(
    "info",
    `issue #${entry.number} agent run finished is_error=${agentResult.isError}`,
    slot,
  );

  // Latch escalation on the first true and persist.
  const nextEscalated =
    escalated ||
    agentResult.needsBlueprintEscalation === true ||
    nextEscalatedFromSteer;
  if (!escalated && nextEscalated) {
    console.log(
      `[dev] blueprint escalation latched for #${entry.number} — subsequent turns will include expanded context`,
    );
  }

  // Stage 3a — pre-PR blueprint self-audit (#81).
  let nextRemediationCount = remediationCount;
  let nextPendingViolations: BlueprintViolation[] | undefined =
    remediationViolations;
  let auditFailed = false;
  if (role === "primary" && entry.kind === "feature" && !agentResult.isError) {
    let auditResult: PrePRSelfAuditResult | null = null;
    try {
      auditResult = await runPrePRSelfAudit({
        issue,
        repoPath: wt.path,
        previousViolations: remediationViolations,
        spawn: spawnFn,
      });
    } catch (err) {
      console.warn(
        `[warn] [dev] blueprint self-audit failed for #${entry.number}: ${err instanceof Error ? err.message : String(err)}`,
      );
      auditResult = {
        conformant: false,
        violations: [
          {
            rule_id: "INFRA-AUDIT-FAILURE",
            rule_name: "self-audit infrastructure error",
            rule_type: "infrastructure",
            domain: "infra",
            concern: err instanceof Error ? err.message : String(err),
          },
        ],
        diffSummary: "",
      };
    }

    if (auditResult) {
      if (auditResult.conformant) {
        nextPendingViolations = undefined;
      } else {
        nextRemediationCount = remediationCount + 1;
        nextPendingViolations = auditResult.violations;
        auditFailed = true;
        if (isRemediationCapExceeded(role, entry.kind, nextRemediationCount)) {
          console.error(
            `[error] [dev] blueprint self-audit remediation cap exceeded for #${entry.number} — manual intervention required (${nextRemediationCount}/${SELF_AUDIT_REMEDIATION_CAP} passes)`,
          );
        } else {
          console.warn(
            `[warn] [dev] blueprint self-audit non-conformant for #${entry.number} (remediation ${nextRemediationCount}/${SELF_AUDIT_REMEDIATION_CAP}) — looping back to develop with violations`,
          );
        }
      }
    }
  }

  if (agentResult.isError) {
    // Clear the session so the next tick starts a fresh agent rather than
    // repeatedly resuming a broken session.
    await deleteSession(client, owner, repo, entry.number);
  } else {
    await upsertSession(client, owner, repo, entry.number, {
      sessionId: agentResult.sessionId,
      role,
      slot,
      startedAt: existing?.session.startedAt ?? new Date().toISOString(),
      blueprintEscalated: nextEscalated || undefined,
      selfAuditRemediationCount: nextRemediationCount || undefined,
      selfAuditPendingViolations: nextPendingViolations,
    });
  }

  return { proceedToMerge: !auditFailed };
}

/**
 * Stage 3: predecessor check and merge eligibility (primary slot only).
 * Returns merge-gate blocked predecessors and whether the issue closed.
 */
async function attemptMergeGate(
  opts: DevLoopOpts,
  plan: Plan,
  entry: PlanIssueMetadata,
): Promise<{ closed: boolean; mergeGateBlocked: number[] }> {
  const { client, owner, repo } = opts;

  const latestPlan = await loadCurrentPlan(client, owner, repo, plan);
  const blockingPredecessors = await collectBlockingPredecessors(
    client,
    owner,
    repo,
    latestPlan,
    entry.number,
  );
  if (blockingPredecessors.length > 0) {
    console.warn(
      `[warn] [dev] merge gate blocked for #${entry.number}: waiting on ${blockingPredecessors.map((n) => `#${n}`).join(", ")}`,
    );
    return { closed: false, mergeGateBlocked: blockingPredecessors };
  }

  const updatedIssue = await client.getIssue(owner, repo, entry.number);
  if (updatedIssue.state === "closed") {
    await deleteSession(client, owner, repo, entry.number);
    return { closed: true, mergeGateBlocked: [] };
  }

  return { closed: false, mergeGateBlocked: [] };
}

/**
 * Runs one slot end-to-end: prep worktree, claim session, spawn agent,
 * update session, detect close.
 */
async function runSlot(
  opts: DevLoopOpts,
  plan: Plan,
  entry: PlanIssueMetadata,
  role: "primary" | "speculative",
  slot: number,
): Promise<{ closed: boolean; mergeGateBlocked: number[] }> {
  devLog("info", `start issue #${entry.number}`, slot);
  // Stage 1: worktree + session setup
  const ctx = await prepareWorktreeAndSession(opts, entry, role, slot);
  if (!ctx) {
    // Issue already closed or remediation cap exceeded
    const { client, owner, repo } = opts;
    const issue = await client.getIssue(owner, repo, entry.number);
    devLog(
      "debug",
      `issue #${entry.number} skipped before spawn (closed=${issue.state === "closed"})`,
      slot,
    );
    return { closed: issue.state === "closed", mergeGateBlocked: [] };
  }

  // Stage 2: agent spawn + audit
  const { proceedToMerge } = await executeAgentWithAudit(
    opts,
    plan,
    entry,
    role,
    slot,
    ctx,
  );

  if (!proceedToMerge) {
    devLog(
      "warn",
      `issue #${entry.number} halted after self-audit; waiting for remediation`,
      slot,
    );
    return { closed: false, mergeGateBlocked: [] };
  }

  // Stage 3: merge gate (primary only)
  if (role === "primary") {
    const mergeResult = await attemptMergeGate(opts, plan, entry);
    if (mergeResult.closed) {
      devLog(
        "info",
        `issue #${entry.number} merge-gate result closed=true`,
        slot,
      );
    } else if (mergeResult.mergeGateBlocked.length > 0) {
      devLog(
        "info",
        `issue #${entry.number} merge-gate result closed=false blocked=${mergeResult.mergeGateBlocked.map((n) => `#${n}`).join(",")}`,
        slot,
      );
    } else {
      devLog(
        "info",
        `issue #${entry.number} merge-gate result closed=false blocked=0 — issue still open, likely waiting on CI or PR merge`,
        slot,
      );
    }
    return mergeResult;
  }

  devLog("trace", `issue #${entry.number} completed (speculative path)`, slot);
  return { closed: false, mergeGateBlocked: [] };
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
  if (primary.kind === "ci-failure") return []; // CI failures are never paired

  const phase = plan.phases.find((p) => p.name === primary.phase);
  if (!phase) return [];
  if (phase.scoutGate === null) return [];

  // Scout gate: scout must be CLOSED
  const scoutIssue = await client.getIssue(owner, repo, phase.scoutGate);
  if (scoutIssue.state !== "closed") return [];

  const candidates: PlanIssueMetadata[] = [];
  for (const entry of phase.issues) {
    if (candidates.length >= count) break;
    if (entry.number === primary.number) continue;
    if (entry.kind === "dev-scout") continue;
    if (await isSpeculativeEligible(client, owner, repo, entry)) {
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
): Promise<{ entry: PlanIssueMetadata | null; blocked: number[] }> {
  const blocked: number[] = [];

  // CI failures take absolute priority
  for (const entry of plan.ciFailures) {
    if (await isEligible(client, owner, repo, entry, plan)) {
      return { entry, blocked };
    }
    if (await isOpen(client, owner, repo, entry)) {
      blocked.push(entry.number);
      return { entry: null, blocked };
    }
  }
  for (const phase of plan.phases) {
    for (const entry of phase.issues) {
      if (await isEligible(client, owner, repo, entry, plan)) {
        const remainingBlocked = await collectMergeGateBlocked(
          client,
          owner,
          repo,
          plan,
          entry.number,
        );
        blocked.push(...remainingBlocked);
        return { entry, blocked };
      }
      if (await isOpen(client, owner, repo, entry)) {
        blocked.push(entry.number);
        return { entry: null, blocked };
      }
    }
  }
  return { entry: null, blocked };
}

async function diagnoseNoPrimaryReason(
  client: GitHubClient,
  owner: string,
  repo: string,
  plan: Plan,
): Promise<string> {
  const planEntries = planIssueOrder(plan);
  if (planEntries.length === 0) {
    return "plan has no entries (cannot select a primary issue)";
  }

  const openIssues = await client.listIssues(owner, repo);
  const openWorkIssues = openIssues.filter(
    (issue) => !issue.labels.includes("plan"),
  );
  if (openWorkIssues.length === 0) {
    return "no open issues in repository";
  }

  const planSet = new Set(planEntries);
  const openReferenced = openWorkIssues.filter((issue) =>
    planSet.has(issue.number),
  );
  if (openReferenced.length === 0) {
    const sample = openWorkIssues
      .slice(0, 5)
      .map((issue) => `#${issue.number}`)
      .join(", ");
    return `open issues are not referenced in Plan (sample open issues: ${sample})`;
  }

  return "no eligible primary (all plan-referenced issues are currently non-runnable)";
}

async function selectStartupPrimary(
  client: GitHubClient,
  owner: string,
  repo: string,
  plan: Plan,
  prioritizedIssueNumbers: number[],
): Promise<PlanIssueMetadata | null> {
  for (const issueNumber of prioritizedIssueNumbers) {
    const entry = findPlanEntry(plan, issueNumber);
    if (!entry) continue;
    if (await isOpen(client, owner, repo, entry)) return entry;
  }
  return null;
}

async function isEligible(
  client: GitHubClient,
  owner: string,
  repo: string,
  entry: PlanIssueMetadata,
  plan: Plan,
): Promise<boolean> {
  if (!(await isOpen(client, owner, repo, entry))) return false;
  return predecessorsClosed(client, owner, repo, plan, entry.number);
}

async function isSpeculativeEligible(
  client: GitHubClient,
  owner: string,
  repo: string,
  entry: PlanIssueMetadata,
): Promise<boolean> {
  if (!(await isOpen(client, owner, repo, entry))) return false;
  if (entry.dependencies.length === 0) return true;
  for (const depNumber of entry.dependencies) {
    const dep = await client.getIssue(owner, repo, depNumber);
    if (dep.state !== "closed") return false;
  }
  return true;
}

export async function predecessorsClosed(
  client: GitHubClient,
  owner: string,
  repo: string,
  plan: Plan,
  issueNumber: number,
): Promise<boolean> {
  const order = planIssueOrder(plan);
  const targetIndex = order.indexOf(issueNumber);
  if (targetIndex < 0) return false;
  for (let i = 0; i < targetIndex; i++) {
    const prev = order[i]!;
    const issue = await client.getIssue(owner, repo, prev);
    if (issue.state !== "closed") return false;
  }
  return true;
}

async function loadCurrentPlan(
  client: GitHubClient,
  owner: string,
  repo: string,
  fallback: Plan,
): Promise<Plan> {
  const planIssue = await findOpenPlanIssue(client, owner, repo);
  if (!planIssue) return fallback;
  return parsePlan(planIssue.body ?? "");
}

/** Scout seam for dev-scout downstream issue hydration in #51. */
export function listPhaseFeatureEntries(
  plan: Plan,
  phaseName: string,
): PlanIssueMetadata[] {
  const phase = plan.phases.find((candidate) => candidate.name === phaseName);
  if (!phase) return [];
  return phase.issues.filter((entry) => entry.kind === "feature");
}

async function collectBlockingPredecessors(
  client: GitHubClient,
  owner: string,
  repo: string,
  plan: Plan,
  issueNumber: number,
): Promise<number[]> {
  const blocked: number[] = [];
  const order = planIssueOrder(plan);
  const targetIndex = order.indexOf(issueNumber);
  if (targetIndex < 0) return blocked;

  for (let i = 0; i < targetIndex; i++) {
    const predecessor = order[i]!;
    const issue = await client.getIssue(owner, repo, predecessor);
    if (issue.state !== "closed") blocked.push(predecessor);
  }

  return blocked;
}

async function collectMergeGateBlocked(
  client: GitHubClient,
  owner: string,
  repo: string,
  plan: Plan,
  selectedIssueNumber: number,
): Promise<number[]> {
  const blocked: number[] = [];
  const order = planIssueOrder(plan);
  const selectedIndex = order.indexOf(selectedIssueNumber);
  if (selectedIndex < 0) return blocked;

  for (let i = selectedIndex + 1; i < order.length; i++) {
    const issueNumber = order[i]!;
    const issue = await client.getIssue(owner, repo, issueNumber);
    if (issue.state !== "closed") {
      const eligible = await predecessorsClosed(
        client,
        owner,
        repo,
        plan,
        issueNumber,
      );
      if (!eligible) blocked.push(issueNumber);
    }
  }

  return blocked;
}

async function isOpen(
  client: GitHubClient,
  owner: string,
  repo: string,
  entry: PlanIssueMetadata,
): Promise<boolean> {
  const issue = await client.getIssue(owner, repo, entry.number);
  return issue.state !== "closed";
}

function findPlanEntry(
  plan: Plan,
  issueNumber: number,
): PlanIssueMetadata | null {
  for (const entry of plan.ciFailures) {
    if (entry.number === issueNumber) return entry;
  }
  for (const phase of plan.phases) {
    for (const entry of phase.issues) {
      if (entry.number === issueNumber) return entry;
    }
  }
  return null;
}

function branchForIssue(entry: PlanIssueMetadata): string {
  const slug = slugFromTitle(entry.title);
  const prefix =
    entry.kind === "dev-scout"
      ? "chore"
      : entry.kind === "ci-failure"
        ? "fix"
        : "feat";
  return `${prefix}/${entry.number}-${slug}`;
}

function slugFromTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^[a-z]+:\s*/, "") // strip conventional prefix
    .replace(/\[.*?\]\s*/g, "") // strip [dev-scout] tags
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

function buildPromptForKind(
  entry: PlanIssueMetadata,
  issue: Issue,
  branch: string,
  wt: IssueWorktree,
  plan: Plan,
  role: "primary" | "speculative",
  escalated: boolean,
  remediationViolations?: BlueprintViolation[],
): string {
  if (entry.kind === "ci-failure") {
    return buildCIFailurePrompt({
      issue,
      checkName: extractCheckName(entry.title),
      checkRunUrl: extractCheckUrl(issue.body),
      sha: extractSha(entry.title),
      worktreePath: wt.path,
      branch,
    });
  }

  if (entry.kind === "dev-scout") {
    const phase = plan.phases.find((p) => p.name === entry.phase);
    return buildDevScoutPrompt({
      scoutIssue: issue,
      worktreePath: wt.path,
      branch,
      phaseName: entry.phase,
      phaseGoal: phase?.goal ?? "",
      featureIssues: listPhaseFeatureEntries(plan, entry.phase),
      escalated,
    });
  }

  return buildDevelopIssuePrompt({
    issue,
    role,
    worktreePath: wt.path,
    branch,
    phaseName: entry.phase,
    escalated,
    remediationViolations,
  });
}

function extractCheckName(title: string): string {
  // "fix(repo): test:unit failed on main @ abc1234" → "test:unit"
  const match = /:\s*(.+?)\s+failed/.exec(title);
  return match?.[1] ?? "unknown";
}

function extractSha(title: string): string {
  const match = /@\s*([a-f0-9]+)/.exec(title);
  return match?.[1] ?? "";
}

function extractCheckUrl(body: string | null): string {
  if (!body) return "";
  const match = /(https:\/\/github\.com\/[^\s)]+\/runs\/\d+)/.exec(body);
  return match?.[1] ?? "";
}

/**
 * Returns a thin proxy over `base` that serves `getIssue` from `cache`.
 * Misses fall through to the real client and populate the cache.
 * All other methods are delegated to `base` unchanged.
 */
function withIssueCache(
  base: GitHubClient,
  cache: Map<number, Issue>,
): GitHubClient {
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "getIssue") {
        return async (
          owner: string,
          repo: string,
          n: number,
        ): Promise<Issue> => {
          const hit = cache.get(n);
          if (hit) return hit;
          const issue = await target.getIssue(owner, repo, n);
          cache.set(n, issue);
          return issue;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function findOpenPlanIssue(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<Issue | null> {
  const allOpenIssues = (await client.listIssues(owner, repo)) ?? [];
  const fallback = allOpenIssues.find(
    (issue) =>
      issue.labels.some((label) => label.toLowerCase() === "plan") ||
      /^plan\b/i.test(issue.title),
  );
  if (fallback) return fallback;

  // Backward-compatible fallback for adapters/mocks that only respect
  // label-filtered issue listing.
  if (allOpenIssues.length === 0) {
    const labeledPlanIssues =
      (await client.listIssues(owner, repo, ["plan"])) ?? [];
    return labeledPlanIssues[0] ?? null;
  }
  return null;
}

async function buildStartupSessionHandoff(
  opts: DevLoopOpts,
  startupPlanIssue?: Issue,
): Promise<{ prioritizedIssueNumbers: number[]; reapedSessions: number[] }> {
  const { client, owner, repo } = opts;
  const planIssue =
    startupPlanIssue ?? (await findOpenPlanIssue(client, owner, repo));
  const plan = planIssue ? parsePlan(planIssue.body ?? "") : emptyPlan();
  const classified = await classifyStartupSessions(
    client,
    owner,
    repo,
    planIssueOrder(plan),
    opts.staleSessionTimeoutMs ?? DEFAULT_STALE_SESSION_MS,
  );

  await Promise.all(
    classified.reapedSessions.map((session) =>
      client.deleteIssueComment(owner, repo, session.commentId),
    ),
  );

  return {
    prioritizedIssueNumbers: classified.prioritizedIssueNumbers,
    reapedSessions: classified.reapedIssueNumbers,
  };
}

function emptyPlan(): Plan {
  return { ciFailures: [], phases: [] };
}

const DEFAULT_STALE_SESSION_MS = 4 * 60 * 60 * 1000; // 4 hours
const SESSION_MARKER = "<!-- superfield-session:";
const SESSION_MARKER_END = "-->";

/**
 * Maintenance pass: prune worktrees for closed issues and reap stale session
 * comments (deadman switch). Called on every idle tick of the dev loop.
 *
 * Worktree pruning: scans all managed worktrees and deletes those whose
 * corresponding issue is now closed on the forge.
 *
 * Session reaping: scans all open issues for session comments older than
 * `staleSessionTimeoutMs`. A stale session means the agent died without
 * cleaning up — deleting the comment allows the issue to be re-claimed.
 */
export async function runPrunePass(opts: DevLoopOpts): Promise<PruneResult> {
  const { client, owner, repo } = opts;
  const worktrees = opts.worktrees ?? new WorktreeManager();
  const staleMs = opts.staleSessionTimeoutMs ?? DEFAULT_STALE_SESSION_MS;
  const now = Date.now();

  const prunedWorktrees: number[] = [];
  const reapedSessions: number[] = [];

  // --- Step 1: Prune worktrees for closed issues ---
  const allWorktrees = await listPrunableWorktrees(worktrees, owner, repo);
  await Promise.all(
    allWorktrees.map(async (wt) => {
      try {
        const issue = await client.getIssue(owner, repo, wt.issueNumber);
        if (issue.state === "closed") {
          await worktrees.prune(
            owner,
            repo,
            wt.issueNumber,
            slugFromPath(wt.path),
          );
          prunedWorktrees.push(wt.issueNumber);
        }
      } catch {
        // Skip if issue cannot be fetched
      }
    }),
  );

  // --- Step 2: Reap stale session comments on open issues ---
  const reapedSessionDetails: Array<{ issueNumber: number; ageMin: number }> =
    [];
  const openIssues = await client.listIssues(owner, repo);
  await Promise.all(
    openIssues.map(async (issue) => {
      try {
        const comments = await client.listIssueComments(
          owner,
          repo,
          issue.number,
        );
        const sessionComment = comments.find((c) =>
          c.body.startsWith(SESSION_MARKER),
        );
        if (!sessionComment) return;

        const jsonStart = sessionComment.body.indexOf("\n") + 1;
        const jsonEnd = sessionComment.body.lastIndexOf(SESSION_MARKER_END);
        if (jsonEnd < 0) return;

        let startedAt: string;
        try {
          const parsed = JSON.parse(
            sessionComment.body.slice(jsonStart, jsonEnd).trim(),
          ) as {
            startedAt: string;
          };
          startedAt = parsed.startedAt;
        } catch {
          return; // malformed session comment — leave it
        }

        const age = now - new Date(startedAt).getTime();
        if (age > staleMs) {
          await client.deleteIssueComment(owner, repo, sessionComment.id);
          reapedSessions.push(issue.number);
          reapedSessionDetails.push({
            issueNumber: issue.number,
            ageMin: Math.round(age / 60_000),
          });
        }
      } catch {
        // Skip if comments cannot be fetched
      }
    }),
  );

  if (prunedWorktrees.length > 0 || reapedSessions.length > 0) {
    const reapedPart =
      reapedSessionDetails.length > 0
        ? reapedSessionDetails
            .map((s) => `#${s.issueNumber}(${s.ageMin}m)`)
            .join(", ")
        : "none";
    devLog(
      "info",
      `prune pass: pruned ${prunedWorktrees.length} worktree(s) (${prunedWorktrees.map((n) => `#${n}`).join(", ") || "none"}) reason=closed, reaped ${reapedSessions.length} stale session(s) (${reapedPart})`,
    );
  } else {
    devLog("debug", "prune pass: nothing to prune");
  }

  return { prunedWorktrees, reapedSessions };
}

async function listPrunableWorktrees(
  worktrees: WorktreeManager,
  owner: string,
  repo: string,
): Promise<IssueWorktree[]> {
  return worktrees.listForRepository(owner, repo);
}

/** Extracts the slug from a worktree path (last path segment after issue-N-). */
function slugFromPath(wtPath: string): string {
  const base = wtPath.split("/").pop() ?? "";
  const match = /^issue-\d+-(.+)$/.exec(base);
  return match?.[1] ?? base;
}
