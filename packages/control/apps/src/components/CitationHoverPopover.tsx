/**
 * @file CitationHoverPopover
 *
 * Simple citation hover popover. Ported from teamster kitchen sink.
 * Self-contained — no external API calls.
 */

import React, { useEffect, useRef } from "react";

export interface CitationData {
  id: string;
  excerpt: string;
  source?: string;
}

export interface CitationHoverPopoverProps {
  citation: CitationData | null;
  anchorRect: DOMRect | null;
  onClose: () => void;
}

export function CitationHoverPopover({
  citation,
  anchorRect,
  onClose,
}: CitationHoverPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!citation) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [citation, onClose]);

  if (!citation || !anchorRect) return null;

  const top = anchorRect.bottom + window.scrollY + 4;
  const left = Math.min(
    anchorRect.left + window.scrollX,
    window.innerWidth - 280,
  );

  return (
    <div
      ref={ref}
      className="fixed z-50 w-64 rounded-lg border border-gray-200 bg-white p-3 shadow-lg text-sm"
      style={{ top, left }}
      onMouseLeave={onClose}
    >
      {citation.source && (
        <p className="mb-1 text-xs font-semibold text-gray-500">
          {citation.source}
        </p>
      )}
      <p className="text-gray-700 leading-snug">{citation.excerpt}</p>
    </div>
  );
}
