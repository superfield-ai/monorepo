export { loadConfig, saveConfig } from './config.ts';
export type { Config, GitHubUser, Repository } from './config.ts';

export { spawnAgent } from './agent.ts';
export type { AgentOpts, AgentResult } from './agent.ts';

export { getSession, upsertSession, deleteSession, findStaleSessions } from './sessions.ts';
export type { AgentRole, AgentSession } from './sessions.ts';

export { buildDevScoutPrompt } from './prompts/dev-scout.ts';
export type { DevScoutContext } from './prompts/dev-scout.ts';

export { buildFeaturePrompt } from './prompts/feature.ts';
export type { FeatureContext } from './prompts/feature.ts';

export { buildCIFailurePrompt } from './prompts/ci-failure.ts';
export type { CIFailureContext } from './prompts/ci-failure.ts';
