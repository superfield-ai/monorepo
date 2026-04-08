export { loadConfig, saveConfig } from './config.ts';
export type { Config, GitHubUser, Repository } from './config.ts';

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
