/**
 * @file FeaturePane
 *
 * Two-column Studio tab layout per docs/ux/studio-ux.md.
 *
 * Left  — Feature rail (220 px fixed): always-visible list + create form.
 * Right — Detail panel (flex-1): description, session log, action form.
 *
 * Selecting a feature in the rail loads detail on the right without
 * replacing the rail. The rail stays visible at all times.
 *
 * Responsive: below 768 px collapses to single-pane drill-down (Option A).
 */

import React, { useEffect, useRef, useState } from "react";
import {
  FeaturePaneController,
  type FeaturePaneState,
  type FeatureItem,
} from "../controllers/FeaturePaneController";
import { TurnTimeline } from "./TurnTimeline";

// ── Design tokens ─────────────────────────────────────────────────────────────

const RAIL_WIDTH = 220;

const LABEL: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  fontWeight: 500,
  letterSpacing: "var(--ls-wider)",
  textTransform: "uppercase",
};

const BTN_PRIMARY: React.CSSProperties = {
  ...LABEL,
  padding: "var(--sp-1) var(--sp-3)",
  background: "transparent",
  color: "var(--accent-cyan)",
  border: "1px solid var(--accent-cyan)",
  cursor: "pointer",
  width: "100%",
};

const BTN_GHOST: React.CSSProperties = {
  ...LABEL,
  padding: "var(--sp-1) var(--sp-3)",
  background: "transparent",
  color: "var(--fg-2)",
  border: "1px solid var(--border-subtle)",
  cursor: "pointer",
};

const TEXTAREA: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  resize: "none",
  background: "var(--bg-base)",
  border: "1px solid var(--border-subtle)",
  color: "var(--fg-1)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-sm)",
  padding: "var(--sp-2) var(--sp-3)",
  outline: "none",
};

// ── Shared form component ─────────────────────────────────────────────────────

function ActionForm({
  placeholder,
  submitLabel,
  onSubmit,
}: {
  placeholder: string;
  submitLabel: string;
  onSubmit: (text: string) => void;
}) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  function submit() {
    const text = value.trim();
    if (!text) return;
    onSubmit(text);
    setValue("");
    ref.current?.focus();
  }

  return (
    <div
      style={{
        padding: "var(--sp-3)",
        borderTop: "1px solid var(--border-subtle)",
        background: "var(--bg-raised)",
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-2)",
      }}
    >
      <textarea
        ref={ref}
        value={value}
        rows={2}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        style={TEXTAREA}
      />
      <button
        type="button"
        disabled={!value.trim()}
        onClick={submit}
        style={{
          ...BTN_PRIMARY,
          opacity: !value.trim() ? 0.4 : 1,
          cursor: !value.trim() ? "not-allowed" : "pointer",
        }}
      >
        {submitLabel}
      </button>
    </div>
  );
}

// ── Section header (flat, no card border) ─────────────────────────────────────

function SectionHeader({ label }: { label: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--sp-3)",
        marginBottom: "var(--sp-3)",
      }}
    >
      <span style={{ ...LABEL, color: "var(--fg-2)" }}>{label}</span>
      <div style={{ flex: 1, height: 1, background: "var(--border-subtle)" }} />
    </div>
  );
}

// ── Feature rail (left column) ────────────────────────────────────────────────

function FeatureRail({
  state,
  selectedIssueNumber,
  onSelect,
  onCreate,
}: {
  state: FeaturePaneState;
  selectedIssueNumber: number | null;
  onSelect: (n: number) => void;
  onCreate: (title: string) => void;
}) {
  const { features, loading, error } = state;

  return (
    <div
      style={{
        width: RAIL_WIDTH,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--bg-raised)",
        borderRight: "1px solid var(--border-subtle)",
      }}
      data-testid="feature-list"
    >
      {/* Rail header */}
      <div
        style={{
          padding: "var(--sp-3) var(--sp-3)",
          borderBottom: "1px solid var(--border-subtle)",
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-2)",
          flexShrink: 0,
        }}
      >
        <span style={{ ...LABEL, color: "var(--fg-1)" }}>FEATURES</span>
        {loading && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              color: "var(--fg-3)",
            }}
          >
            ↻
          </span>
        )}
      </div>

      {/* Rail list */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {error && (
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              color: "var(--accent-red)",
              padding: "var(--sp-2) var(--sp-3)",
              borderBottom: "1px solid var(--border-subtle)",
            }}
          >
            {error}
          </div>
        )}

        {!loading && features.length === 0 && !error && (
          <p
            style={{
              ...LABEL,
              color: "var(--fg-3)",
              textAlign: "center",
              padding: "var(--sp-8) var(--sp-3)",
              lineHeight: 1.6,
            }}
          >
            NO FEATURES
          </p>
        )}

        {features.map((f) => (
          <RailRow
            key={f.issueNumber}
            feature={f}
            selected={f.issueNumber === selectedIssueNumber}
            onSelect={onSelect}
          />
        ))}
      </div>

      {/* Create form */}
      <ActionForm
        placeholder="New feature…"
        submitLabel="CREATE"
        onSubmit={onCreate}
      />
    </div>
  );
}

function RailRow({
  feature,
  selected,
  onSelect,
}: {
  feature: FeatureItem;
  selected: boolean;
  onSelect: (n: number) => void;
}) {
  const isActive = feature.source === "slot";

  return (
    <button
      type="button"
      data-testid={`feature-row-${feature.issueNumber}`}
      onClick={() => onSelect(feature.issueNumber)}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        background: selected ? "var(--bg-base)" : "transparent",
        borderLeft: selected
          ? "2px solid var(--accent-cyan)"
          : "2px solid transparent",
        borderTop: "none",
        borderRight: "none",
        borderBottom: "1px solid var(--border-subtle)",
        padding: "var(--sp-2) var(--sp-3)",
        cursor: "pointer",
        transition: "background var(--duration-fast) var(--ease-out)",
      }}
    >
      {/* Row: dot + number + truncated title */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-1)",
          overflow: "hidden",
        }}
      >
        {isActive && (
          <span
            title="In dev loop"
            style={{
              flexShrink: 0,
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "var(--accent-cyan)",
              display: "inline-block",
            }}
          />
        )}
        <span
          style={{
            ...LABEL,
            color: "var(--accent-cyan)",
            flexShrink: 0,
          }}
        >
          #{feature.issueNumber}
        </span>
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-xs)",
            color: "var(--fg-1)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
        >
          {feature.title}
        </span>
      </div>
      {/* Status badge (local-only items) */}
      {!isActive && (
        <div
          style={{
            ...LABEL,
            color: "var(--fg-3)",
            fontSize: "10px",
            marginTop: 2,
            paddingLeft: "var(--sp-1)",
          }}
        >
          {feature.status}
        </div>
      )}
    </button>
  );
}

// ── Detail panel (right column) ───────────────────────────────────────────────

function NoSelectionPlaceholder() {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <p
        style={{
          ...LABEL,
          color: "var(--fg-3)",
          textAlign: "center",
          lineHeight: 1.8,
        }}
      >
        SELECT A FEATURE
        <br />
        OR CREATE ONE
      </p>
    </div>
  );
}

function DetailPanel({
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

  // Escape key to deselect
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onBack();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

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
      {/* Detail header */}
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
        <button
          type="button"
          onClick={onBack}
          data-testid="feature-back"
          style={BTN_GHOST}
        >
          ← BACK
        </button>
        <span style={{ ...LABEL, color: "var(--accent-cyan)" }}>
          #{feature.issueNumber}
        </span>
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-sm)",
            color: "var(--fg-1)",
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {feature.title}
        </span>
        {hasSession && (
          <span
            style={{ ...LABEL, color: "var(--accent-cyan)", flexShrink: 0 }}
          >
            ACTIVE
          </span>
        )}
      </div>

      {/* Scrollable body */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "var(--sp-4)",
        }}
      >
        {error && (
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              color: "var(--accent-red)",
              padding: "var(--sp-2)",
              border: "1px solid var(--accent-red)",
              marginBottom: "var(--sp-4)",
            }}
          >
            {error}
          </div>
        )}

        {/* DESCRIPTION section */}
        <section style={{ marginBottom: "var(--sp-6)" }}>
          <SectionHeader label="DESCRIPTION" />
          {!feature.body?.trim() ? (
            <p
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs)",
                color: "var(--fg-3)",
              }}
            >
              No description yet — add one using the form below. Use{" "}
              <code
                style={{
                  fontFamily: "var(--font-mono)",
                  background: "var(--bg-raised)",
                  padding: "0 3px",
                }}
              >
                - [ ] task
              </code>{" "}
              for checklist items.
            </p>
          ) : subtasks.length > 0 ? (
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
                      marginTop: 2,
                    }}
                  >
                    {task.done ? "[x]" : "[ ]"}
                  </span>
                  <span
                    style={{
                      textDecoration: task.done ? "line-through" : "none",
                      color: task.done ? "var(--fg-3)" : "var(--fg-1)",
                    }}
                  >
                    {task.text}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs)",
                color: "var(--fg-3)",
              }}
            >
              No checklist items — body has prose but no{" "}
              <code
                style={{
                  fontFamily: "var(--font-mono)",
                  background: "var(--bg-raised)",
                  padding: "0 3px",
                }}
              >
                - [ ]
              </code>{" "}
              lines.
            </p>
          )}
        </section>

        {/* SESSION LOG — only shown when a session exists */}
        {hasSession && (
          <section>
            <SectionHeader label="SESSION LOG" />
            <TurnTimeline sessionId={feature.sessionId as string} />
          </section>
        )}
      </div>

      {/* Docked action form */}
      {hasSession ? (
        <ActionForm
          placeholder="Steer the running agent…"
          submitLabel="STEER"
          onSubmit={(text) =>
            feature.sessionId && onSteer(text, feature.sessionId)
          }
        />
      ) : (
        <ActionForm
          placeholder="Refine the feature spec…"
          submitLabel="UPDATE"
          onSubmit={onPatch}
        />
      )}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

interface Subtask {
  done: boolean;
  text: string;
}

function parseSubtasks(body?: string): Subtask[] {
  if (!body) return [];
  const results: Subtask[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*-\s+\[( |x|X)\]\s+(.+)$/);
    if (m) results.push({ done: m[1] !== " ", text: (m[2] ?? "").trim() });
  }
  return results;
}

function useIsNarrow(breakpoint = 768): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.innerWidth < breakpoint,
  );
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const handler = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mq.addEventListener("change", handler);
    setNarrow(mq.matches);
    return () => mq.removeEventListener("change", handler);
  }, [breakpoint]);
  return narrow;
}

// ── Root component ────────────────────────────────────────────────────────────

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
  const isNarrow = useIsNarrow();

  useEffect(() => {
    const ctrl = controllerRef.current;
    const unsub = ctrl.subscribe(setState);
    ctrl.start();
    return () => {
      unsub();
      ctrl.stop();
    };
  }, []);

  const ctrl = controllerRef.current;
  const selectedFeature =
    state.selectedIssueNumber != null
      ? state.features.find((f) => f.issueNumber === state.selectedIssueNumber)
      : null;

  function handleSelect(n: number) {
    ctrl.selectFeature(n);
  }
  function handleBack() {
    ctrl.selectFeature(null);
  }
  function handleCreate(title: string) {
    void ctrl.createFeature(title);
  }

  // ── Narrow: single-pane drill-down (< 768 px) ────────────────────────────
  if (isNarrow) {
    return (
      <div
        data-testid="feature-pane"
        style={{ display: "flex", height: "100%", flexDirection: "column" }}
      >
        {selectedFeature ? (
          <DetailPanel
            feature={selectedFeature}
            onBack={handleBack}
            onSteer={(text, sessionId) => void ctrl.steer(text, sessionId)}
            onPatch={(text) =>
              void ctrl.patchFeature(selectedFeature.issueNumber, text)
            }
            error={state.error}
          />
        ) : (
          <FeatureRail
            state={state}
            selectedIssueNumber={state.selectedIssueNumber}
            onSelect={handleSelect}
            onCreate={handleCreate}
          />
        )}
      </div>
    );
  }

  // ── Wide: two-column layout ───────────────────────────────────────────────
  return (
    <div
      data-testid="feature-pane"
      style={{ display: "flex", height: "100%", overflow: "hidden" }}
    >
      <FeatureRail
        state={state}
        selectedIssueNumber={state.selectedIssueNumber}
        onSelect={handleSelect}
        onCreate={handleCreate}
      />
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {selectedFeature ? (
          <DetailPanel
            feature={selectedFeature}
            onBack={handleBack}
            onSteer={(text, sessionId) => void ctrl.steer(text, sessionId)}
            onPatch={(text) =>
              void ctrl.patchFeature(selectedFeature.issueNumber, text)
            }
            error={state.error}
          />
        ) : (
          <NoSelectionPlaceholder />
        )}
      </div>
    </div>
  );
}
