import type { AgentBackend } from "./models.ts";
import { ModelTier, MODEL_TIER_MAPPING } from "./models.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type JobType =
  | "dev"
  | "dev-scout"
  | "ci-failure"
  | "plan"
  | "feature-evaluate"
  | "issue-audit"
  | "blueprint-conformance"
  | "doc-coverage"
  | "doc-canonical-sync"
  | "doc-consistency"
  | "pre-pr-self-audit";

/**
 * Abstract tier names used in failover lists.
 * These are resolved against the app-wide tier priority table at runtime.
 */
export type AbstractTierName =
  | "thinking-high"
  | "thinking-medium"
  | "thinking-low"
  | "coding-medium";

/** A concrete (backend, model) pair ready to be passed to the agent CLI. */
export interface CandidateEntry {
  backend: AgentBackend;
  model: string;
}

/** A reference to a specific backend at a specific model tier. */
export interface BackendTierRef {
  backend: AgentBackend;
  tier: ModelTier;
}

/** A failover is either a concrete backend+tier or an abstract tier name. */
export type FailoverRef = BackendTierRef | AbstractTierName;

/**
 * Full spec for one job type: the preferred candidate and an ordered failover
 * list. Abstract tier names in failovers are expanded via the tier table.
 */
export interface JobSpec {
  preferred: BackendTierRef;
  failovers: FailoverRef[];
}

/**
 * App-wide tier priority table. Keys are abstract tier names; values are
 * ordered (backend, model) lists. Missing keys fall back to built-in defaults.
 */
export type TierTable = Partial<Record<AbstractTierName, CandidateEntry[]>>;

// ---------------------------------------------------------------------------
// Built-in defaults
// ---------------------------------------------------------------------------

const DEFAULT_TIER_TABLE: Record<AbstractTierName, CandidateEntry[]> = {
  "thinking-high": [
    { backend: "claude", model: MODEL_TIER_MAPPING.claude[ModelTier.HIGH] },
    { backend: "codex", model: MODEL_TIER_MAPPING.codex[ModelTier.HIGH] },
    {
      backend: "opencode",
      model: MODEL_TIER_MAPPING.opencode[ModelTier.HIGH],
    },
  ],
  "thinking-medium": [
    { backend: "claude", model: MODEL_TIER_MAPPING.claude[ModelTier.MEDIUM] },
    { backend: "codex", model: MODEL_TIER_MAPPING.codex[ModelTier.MEDIUM] },
    {
      backend: "opencode",
      model: MODEL_TIER_MAPPING.opencode[ModelTier.MEDIUM],
    },
  ],
  "thinking-low": [
    { backend: "claude", model: MODEL_TIER_MAPPING.claude[ModelTier.LOW] },
    { backend: "codex", model: MODEL_TIER_MAPPING.codex[ModelTier.LOW] },
    {
      backend: "opencode",
      model: MODEL_TIER_MAPPING.opencode[ModelTier.LOW],
    },
  ],
  "coding-medium": [
    { backend: "codex", model: MODEL_TIER_MAPPING.codex[ModelTier.MEDIUM] },
    { backend: "claude", model: MODEL_TIER_MAPPING.claude[ModelTier.MEDIUM] },
    {
      backend: "opencode",
      model: MODEL_TIER_MAPPING.opencode[ModelTier.MEDIUM],
    },
  ],
};

const MEDIUM_DEV_SPEC: JobSpec = {
  preferred: { backend: "claude", tier: ModelTier.MEDIUM },
  failovers: [{ backend: "codex", tier: ModelTier.MEDIUM }, "thinking-medium"],
};

const BUILT_IN_JOB_SPECS: Record<JobType, JobSpec> = {
  "dev": MEDIUM_DEV_SPEC,
  "dev-scout": MEDIUM_DEV_SPEC,
  "ci-failure": MEDIUM_DEV_SPEC,
  "feature-evaluate": MEDIUM_DEV_SPEC,
  "blueprint-conformance": MEDIUM_DEV_SPEC,
  "doc-coverage": MEDIUM_DEV_SPEC,
  "doc-canonical-sync": MEDIUM_DEV_SPEC,
  "doc-consistency": MEDIUM_DEV_SPEC,
  "pre-pr-self-audit": MEDIUM_DEV_SPEC,
  "plan": {
    preferred: { backend: "claude", tier: ModelTier.HIGH },
    failovers: [{ backend: "codex", tier: ModelTier.HIGH }, "thinking-high"],
  },
  "issue-audit": {
    preferred: { backend: "claude", tier: ModelTier.LOW },
    failovers: [{ backend: "codex", tier: ModelTier.LOW }, "thinking-low"],
  },
};

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function isAbstractTierName(ref: FailoverRef): ref is AbstractTierName {
  return typeof ref === "string";
}

function resolveBackendTierRef(ref: BackendTierRef): CandidateEntry {
  return { backend: ref.backend, model: MODEL_TIER_MAPPING[ref.backend][ref.tier] };
}

/**
 * Returns an ordered list of (backend, model) candidates for a job type.
 *
 * Resolution order:
 *   1. `preferred` entry from the job spec
 *   2. Each entry in `failovers`, in order:
 *      - Concrete `BackendTierRef` → single candidate
 *      - `AbstractTierName` → expanded from the tier table (built-in + overrides)
 *
 * Duplicate (backend, model) pairs are removed, keeping the first occurrence.
 *
 * @param jobType        The inference role being dispatched.
 * @param jobOverrides   Per-job overrides from config — fully replaces the built-in spec.
 * @param tierOverrides  Per-tier overrides from config — merged over built-in tier table.
 */
export function resolveJobCandidates(
  jobType: JobType,
  jobOverrides: Partial<Record<JobType, JobSpec>> = {},
  tierOverrides: TierTable = {},
): CandidateEntry[] {
  const spec = jobOverrides[jobType] ?? BUILT_IN_JOB_SPECS[jobType];
  const tierTable: Record<AbstractTierName, CandidateEntry[]> = {
    ...DEFAULT_TIER_TABLE,
    ...tierOverrides,
  };

  const raw: CandidateEntry[] = [resolveBackendTierRef(spec.preferred)];

  for (const ref of spec.failovers) {
    if (isAbstractTierName(ref)) {
      raw.push(...(tierTable[ref] ?? []));
    } else {
      raw.push(resolveBackendTierRef(ref));
    }
  }

  // Deduplicate by (backend, model), first occurrence wins.
  const seen = new Set<string>();
  const result: CandidateEntry[] = [];
  for (const entry of raw) {
    const key = `${entry.backend}:${entry.model}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(entry);
    }
  }
  return result;
}
