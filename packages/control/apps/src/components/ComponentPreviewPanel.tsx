/**
 * @file ComponentPreviewPanel
 *
 * Studio /studio/preview route — renders components with static fixture data.
 *
 * Access at /studio/preview in the browser during a studio session.
 * Only rendered when studio mode is active (gate at the route level).
 *
 * Mock views are accessible at /studio/preview/<view-name>.
 */

import React, { useState } from "react";
import { WikiRender } from "./WikiRender";
import {
  CitationHoverPopover,
  type CitationData,
} from "./CitationHoverPopover";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const WIKI_FIXTURE = `# Component Preview

This is a **live preview** of agent-generated content.

## Features

- Hot-reloads when the agent modifies components
- Fixture-driven — no backend required
- Access at \`/studio/preview\` during a studio session

### Code Example

\`console.log("Hello from studio preview")\`

Visit [the docs](/app/docs) for more information.
`;

const CITATION_FIXTURE: CitationData = {
  id: "cite-1",
  excerpt: "This is a sample citation excerpt from the source document.",
  source: "Source Document v1.2",
};

// ── Preview views ─────────────────────────────────────────────────────────────

type ViewName = "wiki" | "citations" | "empty";

const VIEWS: { name: ViewName; label: string }[] = [
  { name: "wiki", label: "WikiRender" },
  { name: "citations", label: "CitationHoverPopover" },
  { name: "empty", label: "Empty Shell" },
];

function EmptyShell() {
  return (
    <div className="flex h-full items-center justify-center rounded-lg border-2 border-dashed border-gray-200 p-12 text-center">
      <div>
        <p className="text-gray-500 font-medium">Add a component here</p>
        <p className="mt-1 text-sm text-gray-400">
          Import your component and render it with fixture data from{" "}
          <code className="font-mono text-xs">src/fixtures/</code>
        </p>
      </div>
    </div>
  );
}

function WikiPreview() {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6">
      <h3 className="mb-4 text-xs font-semibold uppercase tracking-wide text-gray-500">
        WikiRender — default
      </h3>
      <WikiRender content={WIKI_FIXTURE} />
    </div>
  );
}

function CitationsPreview() {
  const [hovered, setHovered] = useState<{
    citation: CitationData;
    rect: DOMRect;
  } | null>(null);

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6">
      <h3 className="mb-4 text-xs font-semibold uppercase tracking-wide text-gray-500">
        CitationHoverPopover — hover to see popover
      </h3>
      <p className="text-sm text-gray-700">
        Hover this citation marker:{" "}
        <sup
          className="cursor-pointer text-blue-600 underline"
          onMouseEnter={(e) =>
            setHovered({
              citation: CITATION_FIXTURE,
              rect: e.currentTarget.getBoundingClientRect(),
            })
          }
          onMouseLeave={() => setHovered(null)}
        >
          [1]
        </sup>
      </p>
      <CitationHoverPopover
        citation={hovered?.citation ?? null}
        anchorRect={hovered?.rect ?? null}
        onClose={() => setHovered(null)}
      />
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function ComponentPreviewPanel() {
  const [activeView, setActiveView] = useState<ViewName>("wiki");

  return (
    <div className="flex h-full flex-col overflow-auto p-4">
      {/* View selector */}
      <div className="mb-4 flex gap-2" data-testid="preview-view-selector">
        {VIEWS.map(({ name, label }) => (
          <button
            key={name}
            data-testid={`preview-view-${name}`}
            className={`rounded px-3 py-1.5 text-sm font-medium transition-colors ${
              activeView === name
                ? "bg-blue-50 text-blue-700 border border-blue-200"
                : "text-gray-600 hover:bg-gray-100 border border-transparent"
            }`}
            onClick={() => setActiveView(name)}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Active view */}
      <div className="flex-1" data-testid="preview-content">
        {activeView === "wiki" && <WikiPreview />}
        {activeView === "citations" && <CitationsPreview />}
        {activeView === "empty" && <EmptyShell />}
      </div>
    </div>
  );
}
