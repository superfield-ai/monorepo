/**
 * @file FeaturePane
 *
 * Studio tab main area. Shows features from two sources:
 *   - Active slots (dev loop running, pulsing dot indicator)
 *   - Local DB records (queued/draft/blocked, static badge)
 *
 * Three SteerForm modes driven by context:
 *   List view         → create new feature (POST /studio/issues)
 *   Detail, no session → refine feature spec (PATCH /studio/issues/:n)
 *   Detail, active session → steer running agent (POST /studio/steer)
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
  submitLabel = "SUBMIT",
  onSubmit,
  disabled,
}: {
  placeholder: string;
  submitLabel?: string;
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
        {submitLabel}
      </button>
    </div>
  );
}

// ── Feature list view ─────────────────────────────────────────────────────────

function FeatureListView({
  state,
  onSelect,
  onCreate,
}: {
  state: FeaturePaneState;
  onSelect: (issueNumber: number) => void;
  onCreate: (title: string) => void;
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
            NO FEATURES — describe one below to get started
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

      {/* Create form */}
      <SteerForm
        placeholder="Name a new feature to create…"
        submitLabel="CREATE"
        onSubmit={onCreate}
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
  const isActive = feature.source === "slot";

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
        {/* Active pulse indicator */}
        {isActive && (
          <span
            title="In dev loop"
            style={{
              display: "inline-block",
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "var(--accent-cyan)",
              flexShrink: 0,
              alignSelf: "center",
            }}
          />
        )}
        <span
          className="label"
          style={{ color: "var(--accent-cyan)", flexShrink: 0 }}
        >
          #{feature.issueNumber}
        </span>
        <span style={{ color: "var(--fg-1)" }}>{feature.title}</span>
        {!isActive && (
          <span
            style={{
              marginLeft: "auto",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              color: "var(--fg-3)",
              textTransform: "uppercase",
              letterSpacing: "var(--ls-wider)",
              flexShrink: 0,
            }}
          >
            {feature.status}
          </span>
        )}
      </div>
    </button>
  );
}

// ── Feature detail view ───────────────────────────────────────────────────────

function FeatureDetailView({
  feature,
  onBack,
  onSteer,
  onPatch,
  error,
}: {
  feature: FeatureItem;
  onBack: () => void;
  onSteer: (text: string, sessionId: string) => void;
  onPatch: (text: string) => void;
  error: string | null;
}) {
  const subtasks = parseSubtasks(feature.body);
  const hasSession = !!feature.sessionId;

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
        <button
          type="button"
          onClick={onBack}
          data-testid="feature-back"
          style={BTN_GHOST}
        >
          ← BACK
        </button>
        <span className="label" style={{ color: "var(--accent-cyan)" }}>
          #{feature.issueNumber}
        </span>
        <span style={{ color: "var(--fg-1)", fontSize: "var(--text-sm)" }}>
          {feature.title}
        </span>
        {hasSession && (
          <span
            style={{
              marginLeft: "auto",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              color: "var(--accent-cyan)",
              letterSpacing: "var(--ls-wider)",
            }}
          >
            ACTIVE
          </span>
        )}
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

      {/* Context-aware bottom form */}
      {hasSession ? (
        <SteerForm
          placeholder="Steer the running agent…"
          submitLabel="STEER"
          onSubmit={(text) =>
            feature.sessionId && onSteer(text, feature.sessionId)
          }
        />
      ) : (
        <SteerForm
          placeholder="Refine this feature spec…"
          submitLabel="UPDATE"
          onSubmit={onPatch}
        />
      )}
    </div>
  );
}

interface Subtask {
  done: boolean;
  text: string;
}

function parseSubtasks(body?: string): Subtask[] {
  if (!body) return [];
  const results: Subtask[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*-\s+\[( |x|X)\]\s+(.+)$/);
    if (m) {
      results.push({ done: m[1] !== " ", text: (m[2] ?? "").trim() });
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
          onSteer={(text, sessionId) =>
            void controllerRef.current.steer(text, sessionId)
          }
          onPatch={(text) =>
            void controllerRef.current.patchFeature(
              selectedFeature.issueNumber,
              text,
            )
          }
          error={state.error}
        />
      ) : (
        <FeatureListView
          state={state}
          onSelect={(n) => controllerRef.current.selectFeature(n)}
          onCreate={(title) => void controllerRef.current.createFeature(title)}
        />
      )}
    </div>
  );
}
