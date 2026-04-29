/**
 * Browser controller classes for the Studio web interface.
 *
 * Each controller is a pure TypeScript class with no React imports. Controllers
 * own API calls, SSE streams, and state. React components receive controller
 * instances as props or context and delegate all data-fetching to them.
 *
 * Controllers:
 *  - ChatController: send/receive Claude chat messages with SSE streaming
 *  - ClusterStatusController: SSE connection to cluster events, derives aggregate status
 *  - OAuthController: Claude OAuth init/complete flow with localStorage persistence
 *  - CommitController: fetch commit log, trigger rollback, refresh after chat turns
 *
 * Canonical docs: docs/studio-mode.md
 */

export { ChatController } from "./ChatController";
export type {
  ChatMessage,
  ChatControllerState,
  ChatControllerListener,
  TurnState,
} from "./ChatController";

export { ClusterStatusController } from "./ClusterStatusController";
export type {
  ClusterStatus,
  ClusterStatusListener,
} from "./ClusterStatusController";

export { OAuthController } from "./OAuthController";
export type {
  OAuthStatus,
  OAuthControllerState,
  OAuthControllerListener,
} from "./OAuthController";

export { CommitController } from "./CommitController";
export type {
  Commit,
  TimelineEntry,
  CommitControllerState,
  CommitControllerListener,
} from "./CommitController";

export { FeaturePaneController } from "./FeaturePaneController";
export type {
  FeatureItem,
  FeaturePaneState,
  FeaturePaneListener,
} from "./FeaturePaneController";

export { DocsController } from "./DocsController";
export type { DocsState, DocsListener } from "./DocsController";
