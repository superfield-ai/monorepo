/**
 * @file DebugView.tsx
 *
 * Live-updating timeline of every browser-side and backend-side debug event
 * captured by the DebugStore (DB1, DB3, DB4, DB5, DB6).
 *
 * Filters: level (error / warn / info / debug), source, free-text search.
 * Each entry is expandable; expansion reveals the full stack, request context,
 * breadcrumbs leading up to the event, and a "Copy to clipboard" action.
 *
 * "Clear" empties the store; sessionStorage persistence is handled by
 * debug-store.ts itself.
 */

import React from "react";
import type {
  DebugEntry,
  DebugLevel,
  DebugSource,
} from "../lib/debug-store";
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

const LEVEL_BADGE: Record<DebugLevel, string> = {
  error: "bg-red-700 text-red-50",
  warn: "bg-amber-600 text-amber-50",
  info: "bg-blue-700 text-blue-50",
  debug: "bg-zinc-700 text-zinc-100",
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
      className="flex h-full flex-col bg-zinc-950 text-zinc-100"
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-2 text-sm">
        <span className="font-semibold">Debug</span>
        <span
          data-testid="debug-view-count"
          className="rounded bg-zinc-800 px-2 py-0.5 text-xs"
        >
          {filtered.length} / {state.entries.length}
        </span>
        <div className="ml-2 flex gap-1">
          {LEVELS.map((lvl) => (
            <FilterChip
              key={lvl}
              label={lvl}
              testId={`debug-filter-level-${lvl}`}
              active={levelFilter.has(lvl)}
              onToggle={() =>
                setLevelFilter((prev) => toggle(prev, lvl))
              }
            />
          ))}
        </div>
        <div className="flex gap-1">
          {SOURCES.map((src) => (
            <FilterChip
              key={src}
              label={src}
              testId={`debug-filter-source-${src}`}
              active={sourceFilter.has(src)}
              onToggle={() =>
                setSourceFilter((prev) => toggle(prev, src))
              }
            />
          ))}
        </div>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search…"
          data-testid="debug-search"
          className="ml-auto rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs"
        />
        <button
          type="button"
          onClick={handleClear}
          data-testid="debug-clear"
          className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
        >
          Clear
        </button>
      </header>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div
            data-testid="debug-empty"
            className="p-6 text-sm text-zinc-400"
          >
            No matching events. The application is clean.
          </div>
        ) : (
          <ul className="divide-y divide-zinc-800">
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
      className={`rounded px-2 py-0.5 text-xs ${
        active
          ? "bg-zinc-700 text-zinc-100"
          : "bg-transparent text-zinc-500 hover:text-zinc-300"
      }`}
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

function DebugRow({
  entry,
  expanded,
  onToggle,
}: DebugRowProps): JSX.Element {
  const time = new Date(entry.ts).toISOString().slice(11, 23);
  const handleCopy = async (): Promise<void> => {
    const dump = JSON.stringify(entry, null, 2);
    await navigator.clipboard.writeText(dump);
    toastStore.show({
      severity: "success",
      title: "Copied debug entry",
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

  return (
    <li data-testid="debug-row" data-level={entry.level} data-source={entry.source}>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs hover:bg-zinc-900/60"
      >
        <span className="font-mono text-zinc-500">{time}</span>
        <span className={`rounded px-1.5 py-0.5 font-medium ${LEVEL_BADGE[entry.level]}`}>
          {entry.level}
        </span>
        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">
          {entry.source}
        </span>
        <span className="flex-1 truncate font-mono text-zinc-200">
          {entry.message}
        </span>
      </button>
      {expanded ? (
        <div
          data-testid="debug-row-detail"
          className="space-y-2 border-t border-zinc-800 bg-zinc-900/40 px-4 py-3 text-xs text-zinc-300"
        >
          {entry.context ? (
            <div>
              <div className="text-zinc-500">Context</div>
              <pre className="mt-1 overflow-x-auto rounded bg-zinc-950 p-2 font-mono text-[11px]">
                {JSON.stringify(entry.context, null, 2)}
              </pre>
            </div>
          ) : null}
          {entry.stack ? (
            <div>
              <div className="text-zinc-500">Stack</div>
              <pre className="mt-1 overflow-x-auto rounded bg-zinc-950 p-2 font-mono text-[11px]">
                {entry.stack}
              </pre>
            </div>
          ) : null}
          {entry.breadcrumbs && entry.breadcrumbs.length > 0 ? (
            <div>
              <div className="text-zinc-500">Breadcrumbs</div>
              <ul className="mt-1 space-y-0.5 font-mono text-[11px]">
                {entry.breadcrumbs.map((b, i) => (
                  <li key={i} className="text-zinc-400">
                    <span className="text-zinc-600">
                      {new Date(b.ts).toISOString().slice(11, 23)}{" "}
                    </span>
                    [{b.category}] {b.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleCopy}
              data-testid="debug-row-copy"
              className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
            >
              Copy to clipboard
            </button>
            <button
              type="button"
              onClick={handleOpenIssue}
              data-testid="debug-row-issue"
              className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
            >
              Open issue
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
