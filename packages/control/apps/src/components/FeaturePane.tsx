/**
 * @file FeaturePane
 *
 * Studio tab main area. Replaces the ChatPanel + OrchestratorView split.
 *
 * Two views:
 *   - Feature list (default): shows active features from /analytics/slots.
 *     A steer form at the bottom allows submitting a new feature description.
 *   - Feature detail (when a feature is selected): issue header, subtask
 *     checklist, session log via TurnTimeline, and a contextual steer form.
 *
 * Follows Superfield Control Room design system: near-void backgrounds,
 * sharp 1px borders, ALL-CAPS mono labels, token-sourced colours.
 */

import React, { useEffect, useRef, useState } from "react";
import {
  FeaturePaneController,
  type FeaturePaneState,
  type FeatureItem,
} from "../controllers/FeaturePaneController";
import { TurnTimeline } from "./TurnTimeline";

// ── Shared style constants ────────────────────────────────────────────────────

const SECTION: React.CSSProperties = {
  background: "var(--bg-raised)",
  border: "1px solid var(--border-subtle)",
  padding: "var(--sp-3) var(--sp-4)",
};

const BTN_PRIMARY: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  fontWeight: 500,
  letterSpacing: "var(--ls-wider)",
  textTransform: "uppercase",
  padding: "var(--sp-1) var(--sp-3)",
  background: "transparent",
  color: "var(--accent-cyan)",
  border: "1px solid var(--accent-cyan)",
  cursor: "pointer",
};

const BTN_GHOST: React.CSSProperties = {
  ...BTN_PRIMARY,
  color: "var(--fg-2)",
  border: "1px solid var(--border-subtle)",
  fontSize: "var(--text-xs)",
};

const TEXTAREA_STYLE: React.CSSProperties = {
  flex: 1,
  resize: "none",
  background: "var(--bg-base)",
  border: "1px solid var(--border-subtle)",
  color: "var(--fg-1)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-sm)",
  padding: "var(--sp-2) var(--sp-3)",
  outline: "none",
};

// ── SteerForm — shared prompt form ───────────────────────────────────────────

function SteerForm({
  placeholder,
  onSubmit,
  disabled,
}: {
  placeholder: string;
  onSubmit: (text: string) => void;
  disabled?: boolean;
}) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function submit() {
    const text = value.trim();
    if (!text || disabled) return;
    onSubmit(text);
    setValue("");
    ref.current?.focus();
  }

  return (
    <div
      style={{
        padding: "var(--sp-3) var(--sp-4)",
        borderTop: "1px solid var(--border-subtle)",
        background: "var(--bg-raised)",
        flexShrink: 0,
        display: "flex",
        gap: "var(--sp-2)",
        alignItems: "flex-end",
      }}
    >
      <textarea
        ref={ref}
        value={value}
        rows={2}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        style={{ ...TEXTAREA_STYLE, opacity: disabled ? 0.5 : 1 }}
      />
      <button
        type="button"
        disabled={disabled || !value.trim()}
        onClick={submit}
        style={{
          ...BTN_PRIMARY,
          opacity: disabled || !value.trim() ? 0.4 : 1,
          cursor: disabled || !value.trim() ? "not-allowed" : "pointer",
        }}
      >
        SUBMIT
      </button>
    </div>
  );
}

// ── Feature list view ─────────────────────────────────────────────────────────

function FeatureListView({
  state,
  onSelect,
  onSteer,
}: {
  state: FeaturePaneState;
  onSelect: (issueNumber: number) => void;
  onSteer: (text: string) => void;
}) {
  const { features, loading, error } = state;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--bg-base)",
      }}
      data-testid="feature-list"
    >
      {/* Header */}
      <div
        style={{
          ...SECTION,
          borderTop: "none",
          borderLeft: "none",
          borderRight: "none",
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-3)",
        }}
      >
        <span
          className="label"
          style={{ color: "var(--fg-1)", letterSpacing: "var(--ls-wider)" }}
        >
          FEATURES
        </span>
        {loading && (
          <span style={{ color: "var(--fg-3)", fontSize: "var(--text-xs)" }}>
            loading…
          </span>
        )}
      </div>

      {/* Feature items */}
      <div style={{ flex: 1, overflowY: "auto", padding: "var(--sp-3)" }}>
        {error && (
          <div
            style={{
              color: "var(--accent-red)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              padding: "var(--sp-2)",
              border: "1px solid var(--accent-red)",
              marginBottom: "var(--sp-2)",
            }}
          >
            {error}
          </div>
        )}

        {!loading && features.length === 0 && !error && (
          <p
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              letterSpacing: "var(--ls-wider)",
              textTransform: "uppercase",
              color: "var(--fg-3)",
              textAlign: "center",
              marginTop: "var(--sp-8)",
            }}
          >
            NO ACTIVE FEATURES
          </p>
        )}

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--sp-2)",
          }}
        >
          {features.map((f) => (
            <FeatureRow key={f.issueNumber} feature={f} onSelect={onSelect} />
          ))}
        </div>
      </div>

      {/* Steer form */}
      <SteerForm
        placeholder="Discuss or describe a new feature…"
        onSubmit={onSteer}
      />
    </div>
  );
}

function FeatureRow({
  feature,
  onSelect,
}: {
  feature: FeatureItem;
  onSelect: (issueNumber: number) => void;
}) {
  return (
    <button
      type="button"
      data-testid={`feature-row-${feature.issueNumber}`}
      onClick={() => onSelect(feature.issueNumber)}
      style={{
        width: "100%",
        textAlign: "left",
        background: "var(--bg-raised)",
        border: "1px solid var(--border-subtle)",
        padding: "var(--sp-3)",
        cursor: "pointer",
        color: "var(--fg-1)",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-sm)",
        transition: "border-color var(--duration-fast) var(--ease-out)",
      }}
      onMouseEnter={(e) =>
        ((e.currentTarget as HTMLButtonElement).style.borderColor =
          "var(--accent-cyan)")
      }
      onMouseLeave={(e) =>
        ((e.currentTarget as HTMLButtonElement).style.borderColor =
          "var(--border-subtle)")
      }
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: "var(--sp-2)",
        }}
      >
        <span
          className="label"
          style={{ color: "var(--accent-cyan)", flexShrink: 0 }}
        >
          #{feature.issueNumber}
        </span>
        <span style={{ color: "var(--fg-1)" }}>{feature.title}</span>
      </div>
    </button>
  );
}

// ── Feature detail view ───────────────────────────────────────────────────────

function FeatureDetailView({
  feature,
  onBack,
  onSteer,
  error,
}: {
  feature: FeatureItem;
  onBack: () => void;
  onSteer: (text: string, sessionId?: string) => void;
  error: string | null;
}) {
  const subtasks = parseSubtasks(feature.body);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--bg-base)",
      }}
      data-testid="feature-detail"
    >
      {/* Header */}
      <div
        style={{
          ...SECTION,
          borderTop: "none",
          borderLeft: "none",
          borderRight: "none",
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-3)",
        }}
      >
        <button type="button" onClick={onBack} style={BTN_GHOST}>
          ← BACK
        </button>
        <span className="label" style={{ color: "var(--accent-cyan)" }}>
          #{feature.issueNumber}
        </span>
        <span style={{ color: "var(--fg-1)", fontSize: "var(--text-sm)" }}>
          {feature.title}
        </span>
      </div>

      {/* Scrollable content */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "var(--sp-4)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--sp-4)",
        }}
      >
        {error && (
          <div
            style={{
              color: "var(--accent-red)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              padding: "var(--sp-2)",
              border: "1px solid var(--accent-red)",
            }}
          >
            {error}
          </div>
        )}

        {/* Subtasks */}
        <section style={SECTION}>
          <h2
            className="label"
            style={{ marginBottom: "var(--sp-2)", display: "block" }}
          >
            SUBTASKS
          </h2>
          {subtasks.length === 0 ? (
            <p
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs)",
                color: "var(--fg-3)",
              }}
            >
              No subtasks yet
            </p>
          ) : (
            <ul
              style={{
                listStyle: "none",
                margin: 0,
                padding: 0,
                display: "flex",
                flexDirection: "column",
                gap: "var(--sp-1)",
              }}
            >
              {subtasks.map((task, idx) => (
                <li
                  key={idx}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: "var(--sp-2)",
                    fontFamily: "var(--font-sans)",
                    fontSize: "var(--text-sm)",
                    color: "var(--fg-1)",
                  }}
                >
                  <span
                    style={{
                      flexShrink: 0,
                      color: task.done ? "var(--accent-green)" : "var(--fg-3)",
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--text-xs)",
                    }}
                  >
                    {task.done ? "[x]" : "[ ]"}
                  </span>
                  <span>{task.text}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Session log */}
        <section style={SECTION}>
          <h2
            className="label"
            style={{ marginBottom: "var(--sp-2)", display: "block" }}
          >
            SESSION LOG
          </h2>
          {feature.sessionId ? (
            <TurnTimeline sessionId={feature.sessionId} />
          ) : (
            <p
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs)",
                color: "var(--fg-3)",
              }}
            >
              No active session for this feature.
            </p>
          )}
        </section>
      </div>

      {/* Steer form */}
      <SteerForm
        placeholder="Discuss changes to this feature spec…"
        onSubmit={(text) => onSteer(text, feature.sessionId)}
      />
    </div>
  );
}

interface Subtask {
  done: boolean;
  text: string;
}

/** Parse GitHub-style checklist items from markdown body. */
function parseSubtasks(body?: string): Subtask[] {
  if (!body) return [];
  const results: Subtask[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*-\s+\[( |x|X)\]\s+(.+)$/);
    if (m) {
      results.push({ done: m[1] !== " ", text: m[2].trim() });
    }
  }
  return results;
}

// ── Main FeaturePane component ────────────────────────────────────────────────

interface FeaturePaneProps {
  controller?: FeaturePaneController;
}

export function FeaturePane({ controller: controllerProp }: FeaturePaneProps) {
  const controllerRef = useRef<FeaturePaneController>(
    controllerProp ?? new FeaturePaneController(),
  );
  const [state, setState] = useState<FeaturePaneState>(
    controllerRef.current.getState(),
  );

  useEffect(() => {
    const ctrl = controllerRef.current;
    const unsub = ctrl.subscribe(setState);
    ctrl.start();
    return () => {
      unsub();
      ctrl.stop();
    };
  }, []);

  const selectedFeature =
    state.selectedIssueNumber != null
      ? state.features.find((f) => f.issueNumber === state.selectedIssueNumber)
      : null;

  function handleSteer(text: string, sessionId?: string) {
    void controllerRef.current.steer(text, sessionId);
  }

  return (
    <div
      data-testid="feature-pane"
      style={{
        display: "flex",
        height: "100%",
        flexDirection: "column",
        background: "var(--bg-base)",
      }}
    >
      {selectedFeature ? (
        <FeatureDetailView
          feature={selectedFeature}
          onBack={() => controllerRef.current.selectFeature(null)}
          onSteer={handleSteer}
          error={state.error}
        />
      ) : (
        <FeatureListView
          state={state}
          onSelect={(n) => controllerRef.current.selectFeature(n)}
          onSteer={(text) => handleSteer(text)}
        />
      )}
    </div>
  );
}
