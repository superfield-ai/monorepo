/**
 * @file MockRouteController
 *
 * Pure-TS controller for the mock-route gallery (C-9.3).
 *
 * Owns all network access; exposes a subscribe/getState API consumed by
 * MockRouteGallery. The controller is React-free and fully unit-testable.
 *
 * Actions:
 *   loadRoutes()        → GET /studio/mock-routes
 *   toggleRoute(id)     → POST /studio/mock-routes/:id/toggle
 */

import { fetchJson } from "../lib/net";

export interface MockRoute {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly enabled: boolean;
}

export interface MockRouteState {
  readonly routes: readonly MockRoute[];
  readonly loading: boolean;
  readonly toggling: ReadonlySet<string>;
  readonly error: string | null;
}

export type MockRouteListener = (state: MockRouteState) => void;

export interface MockRouteControllerOptions {
  readonly routesUrl?: string;
}

const INITIAL: MockRouteState = {
  routes: [],
  loading: false,
  toggling: new Set(),
  error: null,
};

export class MockRouteController {
  private state: MockRouteState = INITIAL;
  private readonly listeners: Set<MockRouteListener> = new Set();
  private readonly routesUrl: string;

  constructor({
    routesUrl = "/studio/mock-routes",
  }: MockRouteControllerOptions = {}) {
    this.routesUrl = routesUrl;
  }

  subscribe(listener: MockRouteListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  getState(): MockRouteState {
    return {
      ...this.state,
      routes: [...this.state.routes],
      toggling: new Set(this.state.toggling),
    };
  }

  async loadRoutes(): Promise<void> {
    this.set({ loading: true, error: null });

    const result = await fetchJson<{ routes: MockRoute[] }>(this.routesUrl);
    if (result.ok) {
      this.set({ routes: result.value.routes ?? [], loading: false });
    } else {
      this.set({
        loading: false,
        error: result.error.message ?? "Failed to load mock routes",
      });
    }
  }

  async toggleRoute(id: string): Promise<void> {
    const toggling = new Set(this.state.toggling);
    toggling.add(id);
    this.set({ toggling, error: null });

    const result = await fetchJson<MockRoute>(
      `${this.routesUrl}/${encodeURIComponent(id)}/toggle`,
      { method: "POST" },
    );

    const nextToggling = new Set(this.state.toggling);
    nextToggling.delete(id);

    if (result.ok) {
      const updated = result.value;
      const routes = this.state.routes.map((r) =>
        r.id === updated.id ? updated : r,
      );
      this.set({ routes, toggling: nextToggling });
    } else {
      this.set({
        toggling: nextToggling,
        error: result.error.message ?? "Toggle failed",
      });
    }
  }

  private set(patch: Partial<MockRouteState>): void {
    this.state = { ...this.state, ...patch };
    const snapshot = this.getState();
    for (const l of this.listeners) l(snapshot);
  }
}
