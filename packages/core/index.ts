export { loadConfig, saveConfig } from './config.ts';
export type { Config, GitHubUser, Repository } from './config.ts';

export { runPlanningLoop } from './loop.ts';

export {
  parsePlan,
  serializePlan,
  insertCIFailureAtTop,
  appendToPhase,
  planContainsIssue,
  planIssueOrder,
} from './plan.ts';
export type { Plan, PlanPhase, PlanIssueMetadata, PlanIssueKind } from './plan.ts';

export { runLLMTask, extractJson } from './llm-task.ts';
export type { LLMTaskOpts, LLMTaskResult } from './llm-task.ts';

export { runPlanCoverage } from './steps/plan-coverage.ts';
export type { PlanCoverageResult } from './steps/plan-coverage.ts';

export { runIssueAudit } from './steps/issue-audit.ts';
export type { IssueAuditReport, IssueAuditResult, IssueAuditOpts } from './steps/issue-audit.ts';

export { spawnAgent } from './agent.ts';
export type { AgentOpts, AgentResult } from './agent.ts';

export { getSession, upsertSession, deleteSession, findStaleSessions } from './sessions.ts';
export type { AgentRole, AgentSession } from './sessions.ts';

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
} from './prompts/index.ts';
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
} from './prompts/index.ts';
