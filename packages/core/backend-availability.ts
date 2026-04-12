import type { AgentBackend } from "./models.ts";

export const DEFAULT_BACKOFF_MS = 60_000;

/**
 * Tracks per-backend rate-limit cooldown windows within a single process.
 * When a backend returns a rate-limit error, mark it unavailable for a backoff
 * period. On success, clear it so the backend is preferred again immediately.
 */
export class BackendAvailabilityStore {
  private readonly retryAfter = new Map<AgentBackend, number>();

  /** True if the backend has no active cooldown window. */
  isAvailable(backend: AgentBackend): boolean {
    const retryAt = this.retryAfter.get(backend);
    if (retryAt === undefined) return true;
    return Date.now() >= retryAt;
  }

  /**
   * Record a rate-limit event. The backend will be unavailable until
   * `now + backoffMs`. If an existing window extends further than the new
   * one, it is left unchanged (never shorten an existing cooldown).
   */
  markUnavailable(backend: AgentBackend, backoffMs = DEFAULT_BACKOFF_MS): void {
    const existing = this.retryAfter.get(backend) ?? 0;
    const proposed = Date.now() + backoffMs;
    this.retryAfter.set(backend, Math.max(existing, proposed));
  }

  /** Clear any cooldown window — call after a successful invocation. */
  clearAvailable(backend: AgentBackend): void {
    this.retryAfter.delete(backend);
  }

  /** Reset all cooldown windows. Used in tests to isolate state between cases. */
  reset(): void {
    this.retryAfter.clear();
  }

  /** How many ms until the backend is available again (0 if already available). */
  retryAfterMs(backend: AgentBackend): number {
    const retryAt = this.retryAfter.get(backend);
    if (retryAt === undefined) return 0;
    return Math.max(0, retryAt - Date.now());
  }
}

/** Module-level singleton — shared across all spawnAgent calls in the process. */
export const availabilityStore = new BackendAvailabilityStore();
