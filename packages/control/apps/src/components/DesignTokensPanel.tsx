/**
 * @file DesignTokensPanel.tsx
 *
 * Design tokens panel (D3 / C-9.2). Reads `/app/__tokens.json` (a JSON
 * artefact emitted by the project's design-token build step) and renders
 * grouped sections: colors / typography / spacing / shadows / radii.
 *
 * Click a swatch (or row) → copies the matching Tailwind utility class to the
 * clipboard with a toast confirmation. When the artefact is missing the panel
 * shows an EmptyState with a remediation hint instead of a 404.
 */

import React, { useEffect, useState } from "react";
import { fetchJson } from "../lib/net";
import type { AppError } from "../lib/errors";
import { EmptyState } from "./EmptyState";
import { InlineError } from "./InlineError";
import { toastStore } from "../lib/toast-store";

export interface DesignTokens {
  readonly colors?: Readonly<Record<string, string>>;
  readonly typography?: Readonly<Record<string, string>>;
  readonly spacing?: Readonly<Record<string, string>>;
  readonly shadows?: Readonly<Record<string, string>>;
  readonly radii?: Readonly<Record<string, string>>;
}

const SECTION_LABELS: Array<{ key: keyof DesignTokens; label: string }> = [
  { key: "colors", label: "Colors" },
  { key: "typography", label: "Typography" },
  { key: "spacing", label: "Spacing" },
  { key: "shadows", label: "Shadows" },
  { key: "radii", label: "Radii" },
];

const TAILWIND_PREFIX: Record<keyof DesignTokens, string> = {
  colors: "bg-",
  typography: "text-",
  spacing: "p-",
  shadows: "shadow-",
  radii: "rounded-",
};

interface DesignTokensPanelProps {
  /** Optional pre-loaded tokens (used in tests / Storybook). */
  readonly tokensOverride?: DesignTokens | null;
  /** Test seam: skip the network fetch entirely. */
  readonly skipFetch?: boolean;
}

export function DesignTokensPanel({
  tokensOverride,
  skipFetch,
}: DesignTokensPanelProps = {}): JSX.Element {
  const [tokens, setTokens] = useState<DesignTokens | null>(
    tokensOverride ?? null,
  );
  const [error, setError] = useState<AppError | null>(null);
  const [loading, setLoading] = useState(
    tokensOverride === undefined && !skipFetch,
  );

  useEffect(() => {
    if (tokensOverride !== undefined) {
      setTokens(tokensOverride);
      setLoading(false);
      return;
    }
    if (skipFetch) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      const result = await fetchJson<DesignTokens>("/app/__tokens.json");
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        if (result.error.code === "not_found") {
          setTokens(null);
          return;
        }
        setError(result.error);
        return;
      }
      setTokens(result.value);
    })();
    return () => {
      cancelled = true;
    };
  }, [tokensOverride, skipFetch]);

  const copy = async (cls: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(cls);
      toastStore.show({
        severity: "success",
        title: "Copied to clipboard",
        message: cls,
        timeoutMs: 1800,
      });
    } catch {
      toastStore.show({
        severity: "warn",
        title: "Clipboard unavailable",
        message: cls,
        timeoutMs: 1800,
      });
    }
  };

  if (loading) {
    return (
      <div
        data-testid="design-tokens-panel"
        className="p-3 text-sm text-zinc-400"
      >
        Loading tokens…
      </div>
    );
  }

  if (error) {
    return (
      <div data-testid="design-tokens-panel" className="p-3">
        <InlineError
          title="Failed to load design tokens"
          error={error}
          onRetry={() => window.location.reload()}
        />
      </div>
    );
  }

  if (!tokens) {
    return (
      <div data-testid="design-tokens-panel" className="p-3">
        <EmptyState
          title="Tokens not exported"
          hint="Add `bun run build:tokens` to your project, or check that /app/__tokens.json is served by the web service."
          testId="design-tokens"
        />
      </div>
    );
  }

  const sections = SECTION_LABELS.filter(({ key }) => {
    const entries = tokens[key];
    return entries && Object.keys(entries).length > 0;
  });

  if (sections.length === 0) {
    return (
      <div data-testid="design-tokens-panel" className="p-3">
        <EmptyState
          title="Tokens file is empty"
          hint="The /app/__tokens.json document was reachable but contained no sections."
          testId="design-tokens-empty"
        />
      </div>
    );
  }

  return (
    <div
      data-testid="design-tokens-panel"
      className="flex flex-col gap-4 overflow-y-auto p-3 text-sm text-zinc-100"
    >
      {sections.map(({ key, label }) => {
        const entries = tokens[key] ?? {};
        const prefix = TAILWIND_PREFIX[key];
        return (
          <section
            key={key}
            data-testid={`tokens-section-${key}`}
            className="rounded border border-zinc-800 bg-zinc-900/40 p-3"
          >
            <div className="mb-2 text-xs uppercase tracking-wide text-zinc-400">
              {label}
            </div>
            <ul className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
              {Object.entries(entries).map(([name, value]) => {
                const cls = `${prefix}${name}`;
                return (
                  <li key={name}>
                    <button
                      type="button"
                      data-testid={`token-${key}-${name}`}
                      onClick={() => void copy(cls)}
                      className="flex w-full items-center gap-3 rounded border border-zinc-800 bg-zinc-950 p-2 text-left hover:border-zinc-600"
                    >
                      {key === "colors" ? (
                        <span
                          aria-hidden="true"
                          className="h-6 w-6 shrink-0 rounded border border-zinc-700"
                          style={{ backgroundColor: value }}
                        />
                      ) : null}
                      <span className="flex flex-1 flex-col">
                        <span className="font-mono text-xs">{cls}</span>
                        <span className="text-[11px] text-zinc-500">
                          {value}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
