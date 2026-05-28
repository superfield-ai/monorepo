/**
 * Component tests for CitationHoverPopover (issue #322).
 *
 * Verifies:
 *  - Popover is absent when citation / anchorRect is null
 *  - Popover is visible when a valid citation + anchorRect is provided
 *  - Source label and excerpt text are rendered
 *  - Pressing Escape calls onClose
 *  - Mouse-leave on the popover calls onClose
 */

import React, { useState } from "react";
import { render } from "vitest-browser-react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  CitationHoverPopover,
  type CitationData,
} from "../../src/components/CitationHoverPopover";

afterEach(() => {
  vi.restoreAllMocks();
});

// A DOMRect-like object the popover can use for positioning.
function makeRect(overrides: Partial<DOMRect> = {}): DOMRect {
  return {
    top: 100,
    bottom: 116,
    left: 50,
    right: 200,
    width: 150,
    height: 16,
    x: 50,
    y: 100,
    toJSON: () => ({}),
    ...overrides,
  } as DOMRect;
}

const CITATION: CitationData = {
  id: "cite-1",
  excerpt: "This is the excerpt from the source document.",
  source: "Source Document v1.0",
};

const CITATION_NO_SOURCE: CitationData = {
  id: "cite-2",
  excerpt: "Excerpt without a source label.",
};

describe("CitationHoverPopover", () => {
  test("renders nothing when citation is null", async () => {
    const screen = render(
      <CitationHoverPopover
        citation={null}
        anchorRect={makeRect()}
        onClose={vi.fn()}
      />,
    );
    // No popover div in the DOM.
    const popover = screen.container.querySelector(
      ".fixed.z-50",
    );
    expect(popover).toBeNull();
  });

  test("renders nothing when anchorRect is null", async () => {
    const screen = render(
      <CitationHoverPopover
        citation={CITATION}
        anchorRect={null}
        onClose={vi.fn()}
      />,
    );
    const popover = screen.container.querySelector(".fixed.z-50");
    expect(popover).toBeNull();
  });

  test("renders popover with excerpt when citation and anchorRect are provided", async () => {
    const screen = render(
      <CitationHoverPopover
        citation={CITATION}
        anchorRect={makeRect()}
        onClose={vi.fn()}
      />,
    );
    const popover = screen.container.querySelector(".fixed.z-50");
    expect(popover).not.toBeNull();
    expect(popover?.textContent).toContain(CITATION.excerpt);
  });

  test("renders source label when citation has a source", async () => {
    const screen = render(
      <CitationHoverPopover
        citation={CITATION}
        anchorRect={makeRect()}
        onClose={vi.fn()}
      />,
    );
    const popover = screen.container.querySelector(".fixed.z-50");
    expect(popover?.textContent).toContain("Source Document v1.0");
  });

  test("does not render source label when citation has no source", async () => {
    const screen = render(
      <CitationHoverPopover
        citation={CITATION_NO_SOURCE}
        anchorRect={makeRect()}
        onClose={vi.fn()}
      />,
    );
    // Only excerpt is present — no separate source paragraph.
    const paras = screen.container.querySelectorAll(".fixed.z-50 p");
    expect(paras.length).toBe(1);
    expect(paras[0].textContent).toContain(CITATION_NO_SOURCE.excerpt);
  });

  test("pressing Escape calls onClose", async () => {
    const onClose = vi.fn();
    render(
      <CitationHoverPopover
        citation={CITATION}
        anchorRect={makeRect()}
        onClose={onClose}
      />,
    );
    // Dispatch a keydown Escape on window (the component listens on window).
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("hover-driven visibility: popover appears on hover, disappears after onClose", async () => {
    function Wrapper() {
      const [hovered, setHovered] = useState<{
        citation: CitationData;
        rect: DOMRect;
      } | null>(null);

      return (
        <div>
          <sup
            data-testid="cite-marker"
            onMouseEnter={() =>
              setHovered({ citation: CITATION, rect: makeRect() })
            }
            onMouseLeave={() => setHovered(null)}
          >
            [1]
          </sup>
          <CitationHoverPopover
            citation={hovered?.citation ?? null}
            anchorRect={hovered?.rect ?? null}
            onClose={() => setHovered(null)}
          />
        </div>
      );
    }

    const screen = render(<Wrapper />);

    // Before hover — no popover.
    expect(screen.container.querySelector(".fixed.z-50")).toBeNull();

    // Trigger hover.
    await screen.getByTestId("cite-marker").hover();

    // Popover should now be visible.
    const popover = screen.container.querySelector(".fixed.z-50");
    expect(popover).not.toBeNull();
    expect(popover?.textContent).toContain(CITATION.excerpt);
  });
});
