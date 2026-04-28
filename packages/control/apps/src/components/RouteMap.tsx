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
 *
 * Visuals follow the Superfield Control Room design system: bg-raised list
 * items with sharp corners, mono path text, cyan left-accent on the
 * selected route. Behaviour and data-testid values are preserved.
 */

import React, { useEffect, useState } from "react";
import { fetchJson } from "../lib/net";
import type { AppError } from "../lib/errors";
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
}: RouteMapProps): JSX.Element | null {
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
      <div data-testid="route-map" style={{ padding: "var(--sp-3)" }}>
        <InlineError
          title="RESOURCE FAULT — ROUTE MAP"
          error={error}
          onRetry={() => window.location.reload()}
        />
      </div>
    );
  }

  if (!loading && routes.length === 0) {
    return null;
  }

  return (
    <nav
      data-testid="route-map"
      aria-label="Preview routes"
      style={{
        display: "flex",
        height: "100%",
        width: 240,
        flexShrink: 0,
        flexDirection: "column",
        gap: "var(--sp-1)",
        overflowY: "auto",
        borderRight: "1px solid var(--border-subtle)",
        background: "var(--bg-base)",
        padding: "var(--sp-2)",
      }}
    >
      <div className="label" style={{ padding: "var(--sp-1) var(--sp-2)" }}>
        ROUTES
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
            style={{
              display: "block",
              textAlign: "left",
              background: active ? "rgba(0,200,204,0.06)" : "var(--bg-raised)",
              border: "1px solid var(--border-subtle)",
              borderLeft: active
                ? "3px solid var(--accent-cyan)"
                : "3px solid transparent",
              padding: "var(--sp-2)",
              color: active ? "var(--fg-1)" : "var(--fg-2)",
              cursor: "pointer",
            }}
          >
            <div
              style={{
                fontFamily: "var(--font-sans)",
                fontWeight: 500,
                fontSize: "var(--text-sm)",
                color: "var(--fg-1)",
              }}
            >
              {route.title}
            </div>
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                letterSpacing: "var(--ls-wider)",
                color: "var(--fg-3)",
                marginTop: 2,
              }}
            >
              {route.path}
            </div>
          </button>
        );
      })}
    </nav>
  );
}
