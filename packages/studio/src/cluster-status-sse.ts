/**
 * @file cluster-status-sse.ts
 *
 * SSE endpoint for aggregate cluster health status.
 *
 * ## Route
 *
 *   GET /studio/cluster/events
 *
 * No authentication is required — cluster status is non-sensitive and the
 * browser page needs it before the user has logged in.
 *
 * ## What it does
 *
 * Polls `kubectl --context <STUDIO_CLUSTER_CONTEXT> cluster-info --request-timeout=3s`
 * every POLL_INTERVAL_MS. If the command exits 0 (API server reachable) it emits
 * `{"status":"healthy"}`. Otherwise it emits `{"status":"unknown"}`.
 *
 * The SSE event format consumed by ClusterStatusController in the browser:
 *
 *   event: cluster-status
 *   data: {"status":"healthy"}
 *
 * The browser's ClusterStatusController (apps/web/src/controllers/ClusterStatusController.ts)
 * listens for the named `cluster-status` event type and updates the UI indicator.
 *
 * ## Why kubectl cluster-info (not kubectl get pods)
 *
 * `kubectl cluster-info` checks API-server reachability using the discovery
 * endpoints (`/api`, `/apis`) which are accessible with only the standard
 * `system:discovery` ClusterRole — no additional RBAC is needed.
 *
 * `kubectl get pods --all-namespaces` (used by ClusterEventStream in cluster-events.ts)
 * would give a more granular "restarting/degraded" status but requires a
 * ClusterRole with pod-list permissions. The simpler health check is sufficient
 * to drive the E2E test assertion (`studio-load.spec.ts: cluster status shows healthy`).
 *
 * ## In-cluster kubectl context (E2E)
 *
 * Inside the k3s pod, `docker-entrypoint.sh` writes `/tmp/kubeconfig` using the
 * mounted ServiceAccount token and sets `KUBECONFIG=/tmp/kubeconfig` with context
 * name `default` — matching the `STUDIO_CLUSTER_CONTEXT` default in config.ts.
 * The pod can therefore call `kubectl --context default cluster-info` and receive
 * an exit 0 response, causing the SSE stream to emit `{"status":"healthy"}`.
 *
 * See: docs/studio-e2e-infrastructure.md — "How the Cluster Status Becomes healthy"
 */

type ClusterStatus = 'healthy' | 'unknown';

const POLL_INTERVAL_MS = 5_000;

function makeSseEvent(status: ClusterStatus): Uint8Array {
  return new TextEncoder().encode(
    `event: cluster-status\ndata: ${JSON.stringify({ status })}\n\n`,
  );
}

async function checkClusterStatus(context: string): Promise<ClusterStatus> {
  const proc = Bun.spawn(
    ['kubectl', '--context', context, 'cluster-info', '--request-timeout=3s'],
    { stdout: 'ignore', stderr: 'ignore' },
  );
  const exitCode = await proc.exited;
  return exitCode === 0 ? 'healthy' : 'unknown';
}

/**
 * Returns a streaming SSE Response that emits aggregate cluster status.
 *
 * @param context  kubectl context to check (e.g. "default").
 */
export function clusterStatusSseResponse(context: string): Response {
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Initial heartbeat comment so the browser recognises the connection.
      controller.enqueue(new TextEncoder().encode(': connected\n\n'));

      const emit = async () => {
        const status = await checkClusterStatus(context);
        try {
          controller.enqueue(makeSseEvent(status));
        } catch {
          // Controller closed — stop polling.
          if (pollTimer !== null) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
        }
      };

      // Emit immediately, then on interval.
      await emit();
      pollTimer = setInterval(emit, POLL_INTERVAL_MS);
    },

    cancel() {
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    },
  });
}
