/**
 * @file ProductTab
 *
 * Product tab layout:
 *   - Left panel (~65%): DocsViewer — lists .md files from /studio/docs,
 *     renders selected file with WikiRender.
 *   - Right panel (~35%): <WsChat> — chat sidebar using WsChatController
 *     connected to /studio/ws, labelled "AGENT — PRODUCT".
 *
 * Follows the Superfield Control Room design system.
 */

import React, { useEffect, useRef, useState } from "react";
import { DocsController, type DocsState } from "../controllers/DocsController";
import type { WsChatController } from "../controllers/ChatController";
import { WikiRender } from "./WikiRender";
import { WsChat } from "./chat/WsChat";

// ── DocsViewer ────────────────────────────────────────────────────────────────

interface DocsViewerProps {
  controller?: DocsController;
}

function DocsViewer({ controller: controllerProp }: DocsViewerProps) {
  const controllerRef = useRef<DocsController>(
    controllerProp ?? new DocsController(),
  );
  const [state, setState] = useState<DocsState>(
    controllerRef.current.getState(),
  );

  useEffect(() => {
    const ctrl = controllerRef.current;
    const unsub = ctrl.subscribe(setState);
    void ctrl.loadFileList();
    return unsub;
  }, []);

  const { files, selectedFile, content, loading, error } = state;

  return (
    <div
      data-testid="docs-viewer"
      style={{
        display: "flex",
        width: "100%",
        height: "100%",
        background: "var(--bg-base)",
      }}
    >
      {/* Sidebar: file list */}
      <div
        style={{
          width: 200,
          flexShrink: 0,
          borderRight: "1px solid var(--border-subtle)",
          display: "flex",
          flexDirection: "column",
          background: "var(--bg-raised)",
          overflowY: "auto",
        }}
      >
        {/* Sidebar header */}
        <div
          style={{
            padding: "var(--sp-3) var(--sp-4)",
            borderBottom: "1px solid var(--border-subtle)",
          }}
        >
          <span className="label" style={{ color: "var(--fg-1)" }}>
            DOCS
          </span>
        </div>

        {/* File list */}
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {files.map((filename) => {
            const label = filename.replace(/\.md$/i, "").toUpperCase();
            const isActive = filename === selectedFile;
            return (
              <li key={filename}>
                <button
                  type="button"
                  data-testid={`doc-file-${filename}`}
                  onClick={() =>
                    void controllerRef.current.selectFile(filename)
                  }
                  style={{
                    width: "100%",
                    textAlign: "left",
                    background: "transparent",
                    border: "none",
                    borderLeft: isActive
                      ? "2px solid var(--accent-cyan)"
                      : "2px solid transparent",
                    padding: "var(--sp-2) var(--sp-3)",
                    cursor: "pointer",
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-xs)",
                    letterSpacing: "var(--ls-wider)",
                    color: isActive ? "var(--fg-1)" : "var(--fg-2)",
                    transition: "color var(--duration-fast) var(--ease-out)",
                  }}
                >
                  {label}
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Main content area — only this column grows */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Content header */}
        <div
          style={{
            padding: "var(--sp-3) var(--sp-4)",
            borderBottom: "1px solid var(--border-subtle)",
            background: "var(--bg-raised)",
            flexShrink: 0,
          }}
        >
          <span className="label" style={{ color: "var(--fg-2)" }}>
            {selectedFile
              ? selectedFile.replace(/\.md$/i, "").toUpperCase()
              : "SELECT A FILE"}
          </span>
        </div>

        {/* Content body */}
        <div
          data-testid="docs-content"
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "var(--sp-4)",
            color: "var(--fg-1)",
          }}
        >
          {loading && (
            <p
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs)",
                color: "var(--fg-3)",
              }}
            >
              Loading…
            </p>
          )}
          {error && (
            <p
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs)",
                color: "var(--accent-red)",
              }}
            >
              {error}
            </p>
          )}
          {!loading && !error && content && <WikiRender content={content} />}
          {!loading && !error && !content && !selectedFile && (
            <p
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs)",
                color: "var(--fg-3)",
                textAlign: "center",
                marginTop: "var(--sp-8)",
              }}
            >
              SELECT A FILE FROM THE SIDEBAR.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ── ProductTab root ───────────────────────────────────────────────────────────

interface ProductTabProps {
  docsController?: DocsController;
  chatController?: WsChatController;
}

export function ProductTab({
  docsController,
  chatController,
}: ProductTabProps) {
  return (
    <div
      data-testid="product-tab"
      style={{
        display: "flex",
        height: "100%",
        width: "100%",
        background: "var(--bg-base)",
        overflow: "hidden",
      }}
    >
      {/* Left: docs viewer — takes all remaining space */}
      <div
        style={{ flex: 1, minWidth: 0, overflow: "hidden", display: "flex" }}
      >
        <DocsViewer controller={docsController} />
      </div>

      {/* Right: product chat — fixed 25% column */}
      <div
        style={{
          width: "25%",
          flexShrink: 0,
          overflow: "hidden",
          borderLeft: "1px solid var(--border-subtle)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <WsChat
          label="AGENT — PRODUCT"
          wsEndpoint="/studio/ws"
          controller={chatController}
        />
      </div>
    </div>
  );
}
