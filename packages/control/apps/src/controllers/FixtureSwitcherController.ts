/**
 * @file FixtureSwitcherController
 *
 * Pure-TS controller for the fixture switcher panel.
 *
 * Owns all network access; exposes a subscribe/getState API consumed by
 * FixtureSwitcher. The controller is React-free and fully unit-testable.
 *
 * Actions:
 *   loadFixtures(route)              → GET /studio/fixtures?route=<route>
 *   activateFixture(route, fixture)  → POST /studio/fixtures/activate
 */

import { fetchJson } from "../lib/net";

export interface FixtureSwitcherState {
  readonly fixtures: readonly string[];
  readonly active: string | null;
  readonly route: string | null;
  readonly loading: boolean;
  readonly error: string | null;
}

export type FixtureSwitcherListener = (state: FixtureSwitcherState) => void;

export interface FixtureSwitcherControllerOptions {
  readonly fixturesUrl?: string;
  readonly activateUrl?: string;
}

const INITIAL: FixtureSwitcherState = {
  fixtures: [],
  active: null,
  route: null,
  loading: false,
  error: null,
};

export class FixtureSwitcherController {
  private state: FixtureSwitcherState = INITIAL;
  private readonly listeners: Set<FixtureSwitcherListener> = new Set();
  private readonly fixturesUrl: string;
  private readonly activateUrl: string;

  constructor({
    fixturesUrl = "/studio/fixtures",
    activateUrl = "/studio/fixtures/activate",
  }: FixtureSwitcherControllerOptions = {}) {
    this.fixturesUrl = fixturesUrl;
    this.activateUrl = activateUrl;
  }

  subscribe(listener: FixtureSwitcherListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  getState(): FixtureSwitcherState {
    return {
      ...this.state,
      fixtures: [...this.state.fixtures],
    };
  }

  async loadFixtures(route: string): Promise<void> {
    this.set({ loading: true, error: null, route });

    const result = await fetchJson<{
      fixtures: string[];
      active: string | null;
    }>(`${this.fixturesUrl}?route=${encodeURIComponent(route)}`);

    if (result.ok) {
      this.set({
        fixtures: result.value.fixtures ?? [],
        active: result.value.active ?? null,
        loading: false,
      });
    } else {
      this.set({
        loading: false,
        error: result.error.message ?? "Failed to load fixtures",
      });
    }
  }

  async activateFixture(route: string, fixture: string): Promise<void> {
    this.set({ loading: true, error: null });

    const result = await fetchJson<{ ok: boolean }>(this.activateUrl, {
      method: "POST",
      body: { route, fixture },
    });

    if (result.ok) {
      this.set({ active: fixture, loading: false });
    } else {
      this.set({
        loading: false,
        error: result.error.message ?? "Failed to activate fixture",
      });
    }
  }

  private set(patch: Partial<FixtureSwitcherState>): void {
    this.state = { ...this.state, ...patch };
    const snapshot = this.getState();
    for (const l of this.listeners) l(snapshot);
  }
}
