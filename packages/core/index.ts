export { loadConfig, saveConfig } from "./config.ts";
export type { Config, GitHubUser, Repository } from "./config.ts";

export { runPlanningLoop } from "./loop.ts";
export type { TickRepositoryResult, TickRepositoryOpts } from "./loop.ts";

export { runDevLoop, tickDevLoop, runPrunePass } from "./loops/dev-loop.ts";
export type {
  DevLoopOpts,
  DevLoopTickResult,
  PruneResult,
} from "./loops/dev-loop.ts";

export { runDocLoop, tickDocLoop } from "./loops/doc-loop.ts";
export type {
  DocLoopOpts,
  DocLoopTickOpts,
  DocLoopTickResult,
  DocCoverageMissing,
  DocPatch,
  DocSyncProposal,
  DocConsistencyFinding,
} from "./loops/doc-loop.ts";

export {
  parsePlan,
  serializePlan,
  insertCIFailureAtTop,
  appendToPhase,
  planContainsIssue,
  planIssueOrder,
} from "./plan.ts";
export type {
  Plan,
  PlanPhase,
  PlanIssueMetadata,
  PlanIssueKind,
} from "./plan.ts";

export { runLLMTask, extractJson } from "./llm-task.ts";
export type { LLMTaskOpts, LLMTaskResult } from "./llm-task.ts";

export { runPlanCoverage } from "./steps/plan-coverage.ts";
export type { PlanCoverageResult } from "./steps/plan-coverage.ts";

export { runIssueAudit } from "./steps/issue-audit.ts";
export type {
  IssueAuditReport,
  IssueAuditResult,
  IssueAuditOpts,
} from "./steps/issue-audit.ts";

export { renderIssueBody, isConformantBody } from "./issue-body.ts";
export type { IssueBody } from "./issue-body.ts";

export { runPlanCommand } from "./commands/plan.ts";
export type {
  PlanProposal,
  PlanCommandOpts,
  PlanCommandResult,
} from "./commands/plan.ts";

export { runFeatureCommand } from "./commands/feature.ts";
export type {
  FeatureEvaluation,
  FeatureCommandOpts,
  FeatureCommandResult,
} from "./commands/feature.ts";

export { runBlueprintConformance } from "./steps/blueprint-conformance.ts";
export type {
  BlueprintViolation,
  BlueprintConformanceReport,
  BlueprintConformanceResult,
  BlueprintConformanceOpts,
} from "./steps/blueprint-conformance.ts";

export {
  loadBlueprint,
  pickCandidateDomains,
  filterActiveRules,
  scanGraphForDuplicateKeys,
} from "./blueprint.ts";
export type {
  Blueprint,
  BlueprintDomain,
  BlueprintGraphNode,
  BlueprintRule,
  BlueprintRuleType,
} from "./blueprint.ts";

export { spawnAgent } from "./agent.ts";
export type {
  AgentOpts,
  AgentResult,
  AgentMode,
  AgentBackend,
} from "./agent.ts";

export { withRetry, CircuitBreaker } from "./retry.ts";
export type { RetryOpts, CircuitBreakerOpts } from "./retry.ts";

export {
  getSession,
  upsertSession,
  deleteSession,
  findStaleSessions,
} from "./sessions.ts";
export type { AgentRole, AgentSession } from "./sessions.ts";

export {
  buildDevelopIssuePrompt,
  buildDevScoutPrompt,
  buildCIFailurePrompt,
  buildFeatureEvaluatePrompt,
  buildReplanEvaluatePrompt,
  buildIssueAuditPrompt,
  buildBlueprintConformancePrompt,
  buildDocCoveragePrompt,
  buildDocCanonicalSyncPrompt,
  buildDocConsistencyPrompt,
} from "./prompts/index.ts";
export type {
  DevelopIssueContext,
  DevScoutContext,
  CIFailureContext,
  FeatureEvaluateContext,
  ReplanEvaluateContext,
  IssueAuditContext,
  BlueprintConformanceContext,
  DocCoverageContext,
  DocCanonicalSyncContext,
  DocConsistencyContext,
} from "./prompts/index.ts";
