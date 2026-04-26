/**
 * Studio browser interface components.
 *
 * Entry points for the two-panel Studio Mode UI:
 *  - ControlPanel: root layout component (chat sidebar + iframe)
 *  - ChatPanel: Claude chat with SSE streaming
 *  - IframePanel: Superfield app iframe with reloading overlay
 *  - ClusterStatusIndicator: persistent cluster health badge
 *
 * Canonical docs: docs/studio-mode.md
 */

export { ControlPanel } from './ControlPanel';
export { ChatPanel } from './ChatPanel';
export { IframePanel } from './IframePanel';
export { ClusterStatusIndicator } from './ClusterStatusIndicator';
export type { ClusterStatus } from './ClusterStatusIndicator';
export type { ChatMessage } from '../controllers/ChatController';
export { WikiRender } from './WikiRender';
export { CitationHoverPopover } from './CitationHoverPopover';
export { ComponentPreviewPanel } from './ComponentPreviewPanel';
export { OrchestratorView } from './OrchestratorView';
