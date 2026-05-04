/**
 * @file BlueprintConformanceController
 *
 * Pure-TS controller for the blueprint conformance feed (C-9.7).
 *
 * Owns all network access; exposes a subscribe/getState API consumed by
 * BlueprintConformanceFeed. The controller is React-free and fully
 * unit-testable.
 *
 * Actions:
 *   load()   → GET /studio/conformance
 *   start()  → begin 30-second auto-refresh
 *   stop()   → cancel auto-refresh timer
 */

import { fetchJson } from "../lib/net";

export type ConformanceStatus = "pass" | "fail" | "advisory";

export interface ConformanceRule {
  readonly id: string;
  readonly name: string;
  readonly status: ConformanceStatus;
  readonly detail?: string;
}

export interface ConformanceResult {
  readonly rules: ConformanceRule[];
  readonly updatedAt: string | null;
}

export interface BlueprintConformanceState {
  readonly rules: readonly ConformanceRule[];
  readonly updatedAt: string | null;
  readonly loading: boolean;
  readonly error: string | null;
}

export type ConformanceListener = (state: BlueprintConformanceState) => void;

export interface BlueprintConformanceControllerOptions {
  readonly conformanceUrl?: string;
  /** Auto-refresh interval in ms (default 30 000). Set to 0 to disable. */
  readonly refreshIntervalMs?: number;
}

const INITIAL: BlueprintConformanceState = {
  rules: [],
  updatedAt: null,
  loading: false,
  error: null,
};

export class BlueprintConformanceController {
  private state: BlueprintConformanceState = INITIAL;
  private readonly listeners: Set<ConformanceListener> = new Set();
  private readonly conformanceUrl: string;
  private readonly refreshIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor({
    conformanceUrl = "/studio/conformance",
    refreshIntervalMs = 30_000,
  }: BlueprintConformanceControllerOptions = {}) {
    this.conformanceUrl = conformanceUrl;
    this.refreshIntervalMs = refreshIntervalMs;
  }

  subscribe(listener: ConformanceListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  getState(): BlueprintConformanceState {
    return { ...this.state, rules: [...this.state.rules] };
  }

  async load(): Promise<void> {
    this.set({ loading: true, error: null });

    const result = await fetchJson<ConformanceResult>(this.conformanceUrl);
    if (result.ok) {
      this.set({
        rules: result.value.rules ?? [],
        updatedAt: result.value.updatedAt ?? null,
        loading: false,
      });
    } else {
      this.set({
        loading: false,
        error: result.error.message ?? "Failed to load conformance results",
      });
    }
  }

  /** Start polling every `refreshIntervalMs`. Also fires an immediate load. */
  start(): void {
    void this.load();
    if (this.refreshIntervalMs > 0 && this.timer === null) {
      this.timer = setInterval(() => void this.load(), this.refreshIntervalMs);
    }
  }

  /** Stop polling. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private set(patch: Partial<BlueprintConformanceState>): void {
    this.state = { ...this.state, ...patch };
    const snapshot = this.getState();
    for (const l of this.listeners) l(snapshot);
  }
}
