/**
 * @file FixtureSwitcher
 *
 * Studio sub-view — lets developers switch between fixture variants per route.
 * Available fixtures are read from `<repo>/.studio/fixtures/<route>/` and the
 * active selection is persisted in `<repo>/.studio/active-fixtures.json`.
 *
 * Layout: route input at the top, fixture list as radio buttons, activate button.
 */

import React, { useEffect, useRef, useState } from "react";
import {
  FixtureSwitcherController,
  type FixtureSwitcherState,
} from "../controllers/FixtureSwitcherController";

// ── Design tokens ─────────────────────────────────────────────────────────────

const LABEL: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  fontWeight: 500,
  letterSpacing: "var(--ls-wider)",
  textTransform: "uppercase",
};

// ── Fixture list ──────────────────────────────────────────────────────────────

function FixtureList({
  state,
  selected,
  onSelect,
}: {
  state: FixtureSwitcherState;
  selected: string | null;
  onSelect: (fixture: string) => void;
}) {
  const { fixtures, active, loading, error } = state;

  if (!state.route) {
    return (
      <div
        style={{
          padding: "var(--sp-8)",
          textAlign: "center",
          ...LABEL,
          color: "var(--fg-3)",
        }}
        data-testid="fixture-no-route"
      >
        ENTER A ROUTE TO SEE FIXTURES
      </div>
    );
  }

  if (loading && fixtures.length === 0) {
    return (
      <div
        style={{
          padding: "var(--sp-8)",
          textAlign: "center",
          ...LABEL,
          color: "var(--fg-3)",
        }}
      >
        LOADING...
      </div>
    );
  }

  if (error && fixtures.length === 0) {
    return (
      <div
        style={{
          margin: "var(--sp-4)",
          padding: "var(--sp-3)",
          border: "1px solid var(--accent-red)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          color: "var(--accent-red)",
        }}
        data-testid="fixture-error"
      >
        {error}
      </div>
    );
  }

  if (!loading && fixtures.length === 0) {
    return (
      <div
        style={{
          padding: "var(--sp-8)",
          textAlign: "center",
          ...LABEL,
          color: "var(--fg-3)",
        }}
        data-testid="fixture-empty"
      >
        NO FIXTURES FOUND FOR THIS ROUTE
      </div>
    );
  }

  return (
    <div
      data-testid="fixture-list"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-1)",
        padding: "var(--sp-3) var(--sp-4)",
      }}
    >
      {fixtures.map((fixture) => {
        const isActive = fixture === active;
        const isSelected = fixture === selected;
        return (
          <label
            key={fixture}
            data-testid={`fixture-option-${fixture}`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--sp-2)",
              padding: "var(--sp-2) var(--sp-3)",
              border: `1px solid ${isSelected ? "var(--accent-cyan)" : "var(--border-subtle)"}`,
              cursor: "pointer",
              background: isSelected ? "var(--bg-raised)" : "transparent",
              transition:
                "border-color var(--duration-fast), background var(--duration-fast)",
            }}
          >
            <input
              type="radio"
              name="fixture"
              value={fixture}
              checked={isSelected}
              onChange={() => onSelect(fixture)}
              style={{ accentColor: "var(--accent-cyan)" }}
            />
            <span
              style={{
                ...LABEL,
                color: isSelected ? "var(--fg-1)" : "var(--fg-2)",
                flex: 1,
              }}
            >
              {fixture}
            </span>
            {isActive && (
              <span
                style={{
                  ...LABEL,
                  fontSize: "10px",
                  color: "var(--accent-cyan)",
                  border: "1px solid var(--accent-cyan)",
                  padding: "1px 4px",
                  borderRadius: 2,
                }}
                data-testid={`fixture-active-badge-${fixture}`}
              >
                ACTIVE
              </span>
            )}
          </label>
        );
      })}
    </div>
  );
}

// ── Root component ────────────────────────────────────────────────────────────

interface FixtureSwitcherProps {
  controller?: FixtureSwitcherController;
  /** Pre-selected route (e.g. from RouteMap selection) */
  initialRoute?: string;
}

export function FixtureSwitcher({
  controller: controllerProp,
  initialRoute,
}: FixtureSwitcherProps) {
  const controllerRef = useRef<FixtureSwitcherController>(
    controllerProp ?? new FixtureSwitcherController(),
  );
  const [state, setState] = useState<FixtureSwitcherState>(
    controllerRef.current.getState(),
  );
  const [routeInput, setRouteInput] = useState(initialRoute ?? "");
  const [pendingFixture, setPendingFixture] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = controllerRef.current;
    const unsub = ctrl.subscribe(setState);
    return unsub;
  }, []);

  // When state.active changes, sync pendingFixture to reflect current active
  useEffect(() => {
    setPendingFixture(state.active);
  }, [state.route, state.active]);

  const ctrl = controllerRef.current;

  const handleLoad = () => {
    if (routeInput.trim()) {
      void ctrl.loadFixtures(routeInput.trim());
    }
  };

  const handleActivate = () => {
    if (state.route && pendingFixture) {
      void ctrl.activateFixture(state.route, pendingFixture);
    }
  };

  const canActivate =
    !!state.route &&
    !!pendingFixture &&
    pendingFixture !== state.active &&
    !state.loading;

  return (
    <div
      data-testid="fixture-switcher"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--bg-base)",
      }}
    >
      {/* Toolbar */}
      <div
        style={{
          padding: "var(--sp-2) var(--sp-4)",
          borderBottom: "1px solid var(--border-subtle)",
          background: "var(--bg-raised)",
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-3)",
          flexShrink: 0,
        }}
      >
        <span style={{ ...LABEL, color: "var(--fg-1)" }}>FIXTURES</span>
        {state.loading && (
          <span style={{ ...LABEL, color: "var(--fg-3)" }}>↻</span>
        )}
        {state.error && !state.loading && (
          <span
            style={{ ...LABEL, color: "var(--accent-red)", fontSize: "10px" }}
          >
            ERROR
          </span>
        )}
      </div>

      {/* Route selector */}
      <div
        style={{
          padding: "var(--sp-3) var(--sp-4)",
          borderBottom: "1px solid var(--border-subtle)",
          background: "var(--bg-raised)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--sp-2)",
          flexShrink: 0,
        }}
      >
        <label
          htmlFor="fixture-route-input"
          style={{ ...LABEL, color: "var(--fg-2)" }}
        >
          ROUTE
        </label>
        <div style={{ display: "flex", gap: "var(--sp-2)" }}>
          <input
            id="fixture-route-input"
            data-testid="fixture-route-input"
            type="text"
            value={routeInput}
            onChange={(e) => setRouteInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleLoad();
            }}
            placeholder="/api/example"
            style={{
              flex: 1,
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              background: "var(--bg-base)",
              border: "1px solid var(--border-subtle)",
              color: "var(--fg-1)",
              padding: "4px 8px",
              outline: "none",
            }}
          />
          <button
            type="button"
            data-testid="fixture-load-btn"
            onClick={handleLoad}
            disabled={!routeInput.trim() || state.loading}
            style={{
              ...LABEL,
              padding: "2px 10px",
              background: "transparent",
              border: "1px solid var(--border-subtle)",
              color: "var(--fg-2)",
              cursor:
                !routeInput.trim() || state.loading ? "not-allowed" : "pointer",
              opacity: !routeInput.trim() || state.loading ? 0.5 : 1,
            }}
          >
            LOAD
          </button>
        </div>

        {/* Active fixture status */}
        {state.route && state.active && (
          <div
            style={{
              ...LABEL,
              fontSize: "10px",
              color: "var(--fg-3)",
            }}
            data-testid="fixture-active-status"
          >
            ACTIVE:{" "}
            <span style={{ color: "var(--accent-cyan)" }}>{state.active}</span>
          </div>
        )}
      </div>

      {/* Fixture list */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        <FixtureList
          state={state}
          selected={pendingFixture}
          onSelect={setPendingFixture}
        />
      </div>

      {/* Activate button */}
      {state.fixtures.length > 0 && (
        <div
          style={{
            padding: "var(--sp-3) var(--sp-4)",
            borderTop: "1px solid var(--border-subtle)",
            background: "var(--bg-raised)",
            flexShrink: 0,
          }}
        >
          <button
            type="button"
            data-testid="fixture-activate-btn"
            onClick={handleActivate}
            disabled={!canActivate}
            style={{
              ...LABEL,
              width: "100%",
              padding: "6px 12px",
              background: canActivate ? "var(--accent-cyan)" : "transparent",
              border: `1px solid ${canActivate ? "var(--accent-cyan)" : "var(--border-subtle)"}`,
              color: canActivate ? "var(--bg-base)" : "var(--fg-3)",
              cursor: canActivate ? "pointer" : "not-allowed",
              transition:
                "background var(--duration-fast), color var(--duration-fast)",
            }}
          >
            {state.loading ? "..." : "ACTIVATE"}
          </button>
        </div>
      )}
    </div>
  );
}
