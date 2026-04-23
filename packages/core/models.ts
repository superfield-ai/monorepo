/**
 * Shared model-tier types and mappings used by both agent.ts and job-registry.ts.
 * Lives in its own module to avoid circular imports.
 */

export type AgentBackend = "claude" | "codex" | "opencode";
export type AgentMode = AgentBackend | "auto";
export type AgentLoop = "plan" | "dev" | "doc" | "audit";

export enum ModelTier {
  HIGH = "high",
  MEDIUM = "medium",
  LOW = "low",
}

export interface ModelMapping {
  [ModelTier.HIGH]: string;
  [ModelTier.MEDIUM]: string;
  [ModelTier.LOW]: string;
}

export interface BackendModelMapping {
  claude: ModelMapping;
  codex: ModelMapping;
  opencode: ModelMapping;
}

export const MODEL_TIER_MAPPING: BackendModelMapping = {
  claude: {
    [ModelTier.HIGH]: "opus",
    [ModelTier.MEDIUM]: "sonnet",
    [ModelTier.LOW]: "haiku",
  },
  codex: {
    [ModelTier.HIGH]: "o3",
    [ModelTier.MEDIUM]: "gpt-5.4",
    [ModelTier.LOW]: "gpt-5.4-mini",
  },
  opencode: {
    [ModelTier.HIGH]: "opencode/minimax-m2.5-free",
    [ModelTier.MEDIUM]: "opencode/minimax-m2.5-free",
    [ModelTier.LOW]: "opencode/minimax-m2.5-free",
  },
};

export function getModelForBackend(
  backend: AgentBackend,
  tier: ModelTier = ModelTier.MEDIUM,
): string {
  return (
    MODEL_TIER_MAPPING[backend]?.[tier] ??
    MODEL_TIER_MAPPING[backend]?.[ModelTier.MEDIUM] ??
    "sonnet"
  );
}

export function translateModelForBackend(
  model: string | undefined,
  targetBackend: AgentBackend,
  sourceBackend: AgentBackend,
): string {
  if (!model) return getModelForBackend(targetBackend);

  const sourceTier = findModelTier(model, sourceBackend);
  if (sourceTier) {
    return getModelForBackend(targetBackend, sourceTier);
  }

  return model;
}

function findModelTier(model: string, backend: AgentBackend): ModelTier | null {
  const normalized = model.toLowerCase().trim();
  const mapping = MODEL_TIER_MAPPING[backend];
  if (!mapping) return null;

  for (const tier of [ModelTier.LOW, ModelTier.MEDIUM, ModelTier.HIGH]) {
    if (mapping[tier]?.toLowerCase() === normalized) {
      return tier;
    }
  }
  return null;
}

export function isValidModelTier(value: string): value is ModelTier {
  return Object.values(ModelTier).includes(value as ModelTier);
}

export function modelTierFromString(value: string): ModelTier {
  const normalized = value.toLowerCase().trim();
  if (isValidModelTier(normalized)) {
    return normalized;
  }
  return ModelTier.MEDIUM;
}
