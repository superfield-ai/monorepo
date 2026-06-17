/**
 * @file index.ts — barrel export for studio core packages.
 */

export type {
  StudioClusterConfig,
  K8sResource,
  SecretSpec,
  ServiceHealth,
  VerifyCheck,
  VerifyResult,
} from "./types";

export { spawn } from "./spawn";
export { RELEASE_DOCKERFILE, IGNORED_FILES } from "./studio-config";
export {
  discoverResources,
  discoverSecretRefs,
  discoverImages,
  discoverServicePort,
} from "./manifest-parser";
export { buildImages, rebuildAndRestart } from "./image-builder";
export type { ImageMap } from "./image-builder";
export {
  generateSecrets,
  applySecrets,
  seedApplicationData,
} from "./secret-generator";
export {
  cleanupCluster,
  applyManifests,
  removeNetworkPolicies,
  checkHealth,
  waitForHealthy,
} from "./cluster-manager";
export {
  checkPrerequisites,
  verifyStudioCluster,
  verifyAtStartup,
} from "./verify-cluster";
export { deployLocalCluster, teardownLocalCluster } from "./local-deploy";
export type { LocalDeployOpts } from "./local-deploy";
export {
  translateKubernetesManifest,
  translateDockerCompose,
} from "./fastenv-translate";
export type {
  FastenvManifest,
  FastenvWorkload,
  FastenvHealthCheck,
} from "./fastenv-translate";
export {
  buildStudioBranchName,
  parseStudioBranchName,
  isValidSessionId,
  generateSessionId,
  resolveStudioSession,
} from "./studio-session";
export {
  createWorktree,
  deleteWorktree,
  listWorktrees,
  worktreeExists,
  getMainHash,
  resolveWorktreeBaseDir,
} from "./worktree-manager";
export type {
  WorktreeCreateOptions,
  WorktreeCreateResult,
  WorktreeDeleteOptions,
} from "./worktree-manager";
export {
  startSession,
  restartSession,
  teardownSession,
  isSessionCleanedUp,
} from "./session-lifecycle";
export type { SessionState, SessionStartOptions } from "./session-lifecycle";
export {
  sandboxContainerName,
  buildNetworkRules,
  buildDnsConfig,
  startSandbox,
  stopSandbox,
  listSandboxes,
  cleanupOrphanedSandboxes,
  buildAndExportImage,
  isSandboxRunning,
} from "./container-sandbox";
export type {
  SandboxConfig,
  SandboxState,
  SandboxInfo,
} from "./container-sandbox";
export {
  hasChanges,
  createCheckpoint,
  getTimeline,
  parseTimelineOutput,
  rollbackToCheckpoint,
} from "./checkpoint-manager";
export type {
  CheckpointEntry,
  CreateCheckpointOptions,
  CreateCheckpointResult,
  TimelineOptions,
  RollbackOptions,
} from "./checkpoint-manager";
export {
  NOTES_REF,
  SCHEMA_VERSION,
  initMetadata,
  appendTurn,
  writeMetadata,
  readMetadata,
  pushNotes,
  fetchNotes,
} from "./chat-metadata";
export type {
  ChatSessionMeta,
  ChatTurnMeta,
  ChatMetadata,
  AppendTurnOptions,
} from "./chat-metadata";
