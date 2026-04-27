/**
 * @file RouteMap.tsx
 *
 * Per-route preview map (D2 / C-9.1). Sidebar listing routes from the demo
 * fixture (`<repo>/.studio/demo/routes.json` via /studio/demo/routes). Click
 * a route → updates the iframe `src` to `/app/<route>` via the supplied
 * onSelect callback. Last selection persists per session in localStorage.
 *
 * When the fixture is absent the component renders an EmptyState rather than
 * a blank box.
 */

import React, { useEffect, useState } from "react";
import { fetchJson } from "../lib/net";
import type { AppError } from "../lib/errors";
import { EmptyState } from "./EmptyState";
import { InlineError } from "./InlineError";

export interface DemoRoute {
  readonly path: string;
  readonly title: string;
  readonly description: string;
  readonly mocks?: readonly string[];
  readonly viewports?: readonly string[];
}

interface RoutesResponse {
  readonly routes: readonly DemoRoute[];
}

const STORAGE_KEY = "studio.routeMap.selected";

export function loadSelectedRoute(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveSelectedRoute(path: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, path);
  } catch {
    // Best-effort.
  }
}

interface RouteMapProps {
  readonly onSelect: (path: string) => void;
  /** Optional pre-fetched routes (used in tests / Storybook). */
  readonly routesOverride?: readonly DemoRoute[];
  /** Selected route path, controlled. Falls back to localStorage. */
  readonly selected?: string;
}

export function RouteMap({
  onSelect,
  routesOverride,
  selected,
}: RouteMapProps): JSX.Element {
  const [routes, setRoutes] = useState<readonly DemoRoute[]>(
    routesOverride ?? [],
  );
  const [error, setError] = useState<AppError | null>(null);
  const [loading, setLoading] = useState(routesOverride === undefined);

  useEffect(() => {
    if (routesOverride !== undefined) {
      setRoutes(routesOverride);
      setLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      const result = await fetchJson<RoutesResponse>("/studio/demo/routes");
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setRoutes(result.value.routes ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [routesOverride]);

  const activePath = selected ?? loadSelectedRoute();

  if (error) {
    return (
      <div data-testid="route-map" className="p-3">
        <InlineError
          title="Failed to load route map"
          error={error}
          onRetry={() => window.location.reload()}
        />
      </div>
    );
  }

  if (!loading && routes.length === 0) {
    return (
      <div data-testid="route-map" className="p-3">
        <EmptyState
          title="No demo routes configured"
          hint="Run `bun run scripts/seed-demo.ts` to populate .studio/demo/routes.json."
          testId="route-map"
        />
      </div>
    );
  }

  return (
    <nav
      data-testid="route-map"
      aria-label="Preview routes"
      className="flex h-full w-64 shrink-0 flex-col gap-1 overflow-y-auto border-r border-zinc-800 bg-zinc-950 p-2 text-xs"
    >
      <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-zinc-500">
        Routes
      </div>
      {routes.map((route) => {
        const active = route.path === activePath;
        return (
          <button
            key={route.path}
            type="button"
            data-testid={`route-item-${route.path}`}
            onClick={() => {
              saveSelectedRoute(route.path);
              onSelect(route.path);
            }}
            className={
              active
                ? "rounded bg-blue-600/30 px-2 py-1 text-left text-blue-100"
                : "rounded px-2 py-1 text-left text-zinc-300 hover:bg-zinc-900"
            }
          >
            <div className="font-medium">{route.title}</div>
            <div className="font-mono text-[10px] text-zinc-500">
              {route.path}
            </div>
          </button>
        );
      })}
    </nav>
  );
}
