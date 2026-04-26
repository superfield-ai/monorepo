/**
 * @file WikiRender
 *
 * Renders markdown content as HTML. Ported from teamster kitchen sink.
 * Self-contained — no external API calls or citation resolution.
 *
 * For use in the studio /studio/preview route to display agent-generated
 * wiki-style output during a live session.
 */

import React, { useMemo } from "react";

export interface WikiRenderProps {
  content: string;
  className?: string;
}

/** Minimal markdown → HTML renderer (headings, bold, italic, code, links). */
export function renderMarkdown(md: string): string {
  return md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/^#{6}\s+(.+)$/gm, "<h6>$1</h6>")
    .replace(/^#{5}\s+(.+)$/gm, "<h5>$1</h5>")
    .replace(/^#{4}\s+(.+)$/gm, "<h4>$1</h4>")
    .replace(/^#{3}\s+(.+)$/gm, "<h3>$1</h3>")
    .replace(/^#{2}\s+(.+)$/gm, "<h2>$1</h2>")
    .replace(/^#{1}\s+(.+)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>')
    .replace(/^\s*[-*]\s+(.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>\n?)+/g, "<ul>$&</ul>")
    .replace(/\n{2,}/g, "</p><p>")
    .replace(/^(?!<[h|u|p|l])(.+)$/gm, "<p>$1</p>");
}

export function WikiRender({ content, className = "" }: WikiRenderProps) {
  const html = useMemo(() => renderMarkdown(content), [content]);

  return (
    <article
      className={`prose prose-sm max-w-none ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
