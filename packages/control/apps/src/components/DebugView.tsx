/**
 * @file DebugView.tsx
 *
 * Live-updating timeline of every browser-side and backend-side debug event
 * captured by the DebugStore (DB1, DB3, DB4, DB5, DB6).
 *
 * Filters: level (error / warn / info / debug), source, free-text search.
 * Each entry is a flat `bg-raised` row with a status-coloured left border;
 * expansion reveals the full stack, request context, breadcrumbs leading up
 * to the event, and a "Copy to clipboard" action.
 *
 * "Clear" empties the store; sessionStorage persistence is handled by
 * debug-store.ts itself.
 *
 * Visuals follow the Superfield Control Room design system: near-void
 * backgrounds, sharp 1px borders, mono ALL-CAPS labels, status badges.
 * Behaviour and `data-testid` values are preserved.
 */

import React from "react";
import type { DebugEntry, DebugLevel, DebugSource } from "../lib/debug-store";
import { debugStore } from "../lib/debug-store";
import { toastStore } from "../lib/toast-store";

const LEVELS: readonly DebugLevel[] = ["error", "warn", "info", "debug"];
const SOURCES: readonly DebugSource[] = [
  "console",
  "window",
  "fetch",
  "eventsource",
  "websocket",
  "react",
  "backend",
  "breadcrumb",
];

const LEVEL_BADGE_CLASS: Record<DebugLevel, string> = {
  error: "badge badge-critical",
  warn: "badge badge-caution",
  info: "badge badge-info",
  debug: "badge badge-offline",
};

const LEVEL_ACCENT: Record<DebugLevel, string> = {
  error: "var(--accent-red)",
  warn: "var(--accent-amber)",
  info: "var(--accent-blue)",
  debug: "var(--status-offline)",
};

export function DebugView(): JSX.Element {
  const [state, setState] = React.useState(() => debugStore.getState());
  const [levelFilter, setLevelFilter] = React.useState<Set<DebugLevel>>(
    () => new Set(LEVELS),
  );
  const [sourceFilter, setSourceFilter] = React.useState<Set<DebugSource>>(
    () => new Set(SOURCES),
  );
  const [search, setSearch] = React.useState("");
  const [expanded, setExpanded] = React.useState<string | null>(null);

  React.useEffect(() => debugStore.subscribe(setState), []);
  React.useEffect(() => {
    debugStore.markAllRead();
  }, [state.entries.length]);

  const filtered = state.entries.filter((e) => {
    if (!levelFilter.has(e.level)) return false;
    if (!sourceFilter.has(e.source)) return false;
    if (search && !e.message.toLowerCase().includes(search.toLowerCase()))
      return false;
    return true;
  });

  const handleClear = (): void => {
    debugStore.clear();
  };

  return (
    <div
      data-testid="debug-view"
      style={{
        display: "flex",
        height: "100%",
        flexDirection: "column",
        background: "var(--bg-base)",
        color: "var(--fg-1)",
      }}
    >
      <header
        aria-label="Debug controls"
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "var(--sp-2)",
          borderBottom: "1px solid var(--border-subtle)",
          padding: "var(--sp-2) var(--sp-4)",
          background: "var(--bg-raised)",
        }}
      >
        <span className="label" style={{ color: "var(--fg-1)" }}>
          DEBUG
        </span>
        <span
          data-testid="debug-view-count"
          className="badge badge-offline"
          data-pill="true"
        >
          {filtered.length} / {state.entries.length}
        </span>
        <div
          role="group"
          aria-label="Level filters"
          style={{
            display: "flex",
            gap: "var(--sp-1)",
            marginLeft: "var(--sp-2)",
          }}
        >
          {LEVELS.map((lvl) => (
            <FilterChip
              key={lvl}
              label={lvl}
              testId={`debug-filter-level-${lvl}`}
              active={levelFilter.has(lvl)}
              onToggle={() => setLevelFilter((prev) => toggle(prev, lvl))}
            />
          ))}
        </div>
        <div role="group" aria-label="Source filters" style={{ display: "flex", gap: "var(--sp-1)" }}>
          {SOURCES.map((src) => (
            <FilterChip
              key={src}
              label={src}
              testId={`debug-filter-source-${src}`}
              active={sourceFilter.has(src)}
              onToggle={() => setSourceFilter((prev) => toggle(prev, src))}
            />
          ))}
        </div>
        <input
          type="search"
          aria-label="Search debug events"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="SEARCH…"
          data-testid="debug-search"
          style={{
            marginLeft: "auto",
            background: "var(--bg-base)",
            border: "1px solid var(--border-subtle)",
            color: "var(--fg-1)",
            padding: "var(--sp-1) var(--sp-2)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            letterSpacing: "var(--ls-wider)",
            outline: "none",
          }}
        />
        <button
          type="button"
          onClick={handleClear}
          data-testid="debug-clear"
          style={{
            background: "transparent",
            border: "1px solid var(--border-default)",
            color: "var(--fg-1)",
            padding: "var(--sp-1) var(--sp-3)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            letterSpacing: "var(--ls-wider)",
            textTransform: "uppercase",
            cursor: "pointer",
          }}
        >
          CLEAR
        </button>
      </header>

      <div style={{ flex: 1, overflowY: "auto", padding: "var(--sp-3)" }}>
        {filtered.length === 0 ? (
          <div
            data-testid="debug-empty"
            style={{
              padding: "var(--sp-6)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              letterSpacing: "var(--ls-wider)",
              color: "var(--fg-3)",
            }}
          >
            {state.entries.length === 0 ? (
              "No events recorded yet. Errors, warnings, and debug events from the browser and server will appear here."
            ) : (
              <span style={{ textTransform: "uppercase" }}>
                NO MATCHING EVENTS — APPLICATION CLEAN.
              </span>
            )}
          </div>
        ) : (
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: "var(--sp-2)",
            }}
          >
            {filtered.map((entry) => (
              <DebugRow
                key={entry.id}
                entry={entry}
                expanded={expanded === entry.id}
                onToggle={() =>
                  setExpanded(expanded === entry.id ? null : entry.id)
                }
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function toggle<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

interface FilterChipProps {
  readonly label: string;
  readonly active: boolean;
  readonly testId: string;
  readonly onToggle: () => void;
}

function FilterChip({
  label,
  active,
  testId,
  onToggle,
}: FilterChipProps): JSX.Element {
  return (
    <button
      type="button"
      onClick={onToggle}
      data-testid={testId}
      data-active={active}
      data-pill="true"
      className={`badge ${active ? "" : "badge-offline"}`}
      style={{
        cursor: "pointer",
        ...(active
          ? {
              color: "var(--accent-cyan)",
              background: "rgba(0,200,204,0.06)",
              borderColor: "var(--accent-cyan)",
            }
          : {}),
      }}
    >
      {label}
    </button>
  );
}

interface DebugRowProps {
  readonly entry: DebugEntry;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}

function DebugRow({ entry, expanded, onToggle }: DebugRowProps): JSX.Element {
  const time = new Date(entry.ts).toISOString().slice(11, 23);
  const handleCopy = async (): Promise<void> => {
    const dump = JSON.stringify(entry, null, 2);
    await navigator.clipboard.writeText(dump);
    toastStore.show({
      severity: "success",
      title: "COPIED — DEBUG ENTRY",
      timeoutMs: 2000,
    });
  };
  const handleOpenIssue = (): void => {
    const params = new URLSearchParams({
      title: `[debug] ${entry.message.slice(0, 80)}`,
      body: ["```", JSON.stringify(entry, null, 2), "```"].join("\n"),
    });
    window.open(
      `https://github.com/superfield-ai/superfield-cli-ts/issues/new?${params.toString()}`,
      "_blank",
      "noreferrer",
    );
  };

  const accent = LEVEL_ACCENT[entry.level];

  return (
    <li
      data-testid="debug-row"
      data-level={entry.level}
      data-source={entry.source}
      style={{
        background: "var(--bg-raised)",
        border: "1px solid var(--border-subtle)",
        borderLeft: `3px solid ${accent}`,
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        style={{
          display: "flex",
          width: "100%",
          alignItems: "center",
          gap: "var(--sp-2)",
          padding: "var(--sp-2) var(--sp-3)",
          textAlign: "left",
          background: "transparent",
          border: "none",
          color: "var(--fg-1)",
          cursor: "pointer",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
        }}
      >
        <span
          style={{
            color: "var(--fg-3)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {time}
        </span>
        <span className={LEVEL_BADGE_CLASS[entry.level]} data-pill="true">
          {entry.level}
        </span>
        <span
          data-pill="true"
          className="badge badge-offline"
          style={{ color: "var(--fg-2)" }}
        >
          {entry.source}
        </span>
        <span
          style={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontFamily: "var(--font-mono)",
            color: "var(--fg-1)",
          }}
        >
          {entry.message}
        </span>
      </button>
      {expanded ? (
        <div
          data-testid="debug-row-detail"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--sp-2)",
            borderTop: "1px solid var(--border-subtle)",
            background: "var(--bg-base)",
            padding: "var(--sp-3) var(--sp-4)",
            fontSize: "var(--text-xs)",
            color: "var(--fg-2)",
          }}
        >
          {entry.context ? (
            <div>
              <div className="label">CONTEXT</div>
              <pre style={detailPreStyle}>
                {JSON.stringify(entry.context, null, 2)}
              </pre>
            </div>
          ) : null}
          {entry.stack ? (
            <div>
              <div className="label">STACK</div>
              <pre style={detailPreStyle}>{entry.stack}</pre>
            </div>
          ) : null}
          {entry.breadcrumbs && entry.breadcrumbs.length > 0 ? (
            <details>
              <summary
                className="label"
                style={{ cursor: "pointer", listStyle: "none" }}
              >
                BREADCRUMBS ({entry.breadcrumbs.length})
              </summary>
              <ul
                style={{
                  listStyle: "none",
                  margin: "var(--sp-1) 0 0 0",
                  padding: 0,
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                }}
              >
                {entry.breadcrumbs.map((b, i) => (
                  <li key={i} style={{ color: "var(--fg-2)" }}>
                    <span style={{ color: "var(--fg-3)" }}>
                      {new Date(b.ts).toISOString().slice(11, 23)}{" "}
                    </span>
                    [{b.category}] {b.message}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <div style={{ display: "flex", gap: "var(--sp-2)" }}>
            <button
              type="button"
              onClick={handleCopy}
              data-testid="debug-row-copy"
              style={detailButtonStyle}
            >
              COPY TO CLIPBOARD
            </button>
            <button
              type="button"
              onClick={handleOpenIssue}
              data-testid="debug-row-issue"
              style={detailButtonStyle}
            >
              OPEN ISSUE
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

const detailPreStyle: React.CSSProperties = {
  marginTop: "var(--sp-1)",
  overflowX: "auto",
  background: "var(--bg-void)",
  border: "1px solid var(--border-subtle)",
  padding: "var(--sp-2)",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--fg-1)",
};

const detailButtonStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--border-default)",
  color: "var(--fg-1)",
  padding: "var(--sp-1) var(--sp-2)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  letterSpacing: "var(--ls-wider)",
  textTransform: "uppercase",
  cursor: "pointer",
};
