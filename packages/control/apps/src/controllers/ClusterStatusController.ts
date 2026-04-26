/**
 * @file ClusterStatusController
 *
 * Pure TypeScript controller that manages the SSE connection to the cluster
 * events stream at GET /studio/cluster/events. No React imports.
 *
 * Responsibilities:
 *  - Open an EventSource connection to the cluster events SSE endpoint
 *  - Parse incoming "cluster-status" events and derive aggregate status
 *  - Fall back to 'unknown' on connection errors
 *  - Reconnect automatically via EventSource's built-in retry behaviour
 *  - Notify subscribers on every status change
 *
 * Canonical docs: docs/studio-mode.md — "Cluster Status Stream"
 *
 * Browser-native APIs used: EventSource
 * No React imports.
 */

export type ClusterStatus = "healthy" | "restarting" | "degraded" | "unknown";

export type ClusterStatusListener = (status: ClusterStatus) => void;

const VALID_STATUSES: ReadonlySet<ClusterStatus> = new Set([
  "healthy",
  "restarting",
  "degraded",
  "unknown",
]);

/**
 * ClusterStatusController subscribes to the cluster SSE stream and exposes
 * the current aggregate cluster status to listeners.
 *
 * Usage:
 *   const ctrl = new ClusterStatusController({ eventsUrl: '/studio/cluster/events' });
 *   const unsub = ctrl.subscribe(setStatus);
 *   // later:
 *   unsub();
 *   ctrl.dispose();
 */
export class ClusterStatusController {
  private status: ClusterStatus = "unknown";
  private listeners: Set<ClusterStatusListener> = new Set();
  private source: EventSource | null = null;
  private readonly eventsUrl: string;

  constructor({
    eventsUrl = "/studio/cluster/events",
  }: { eventsUrl?: string } = {}) {
    this.eventsUrl = eventsUrl;
  }

  /**
   * Open the SSE connection and start listening for cluster-status events.
   * Safe to call multiple times — subsequent calls are no-ops if already connected.
   */
  connect(): void {
    if (this.source) return;

    this.source = new EventSource(this.eventsUrl);

    this.source.addEventListener("cluster-status", (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data as string) as {
          status?: ClusterStatus;
        };
        if (data.status && VALID_STATUSES.has(data.status)) {
          this.setStatus(data.status);
        }
      } catch {
        // Ignore malformed events
      }
    });

    this.source.onerror = () => {
      this.setStatus("unknown");
      // EventSource will automatically retry — no manual reconnect needed
    };
  }

  /** Close the SSE connection and release resources. */
  dispose(): void {
    this.source?.close();
    this.source = null;
    this.listeners.clear();
  }

  /** Register a listener that is called on every status change. Returns unsubscribe fn. */
  subscribe(listener: ClusterStatusListener): () => void {
    this.listeners.add(listener);
    // Immediately deliver current status
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  getStatus(): ClusterStatus {
    return this.status;
  }

  private setStatus(next: ClusterStatus): void {
    if (next === this.status) return;
    this.status = next;
    for (const listener of this.listeners) {
      listener(this.status);
    }
  }
}
