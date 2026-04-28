/**
 * @file ProductTab
 *
 * Product tab layout:
 *   - Left panel (~65%): DocsViewer — lists .md files from /studio/docs,
 *     renders selected file with WikiRender.
 *   - Right panel (~35%): ProductChatPanel — chat sidebar using WsChatController
 *     connected to /studio/ws, labelled "AGENT — PRODUCT".
 *
 * Follows the Superfield Control Room design system.
 */

import React, { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import { DocsController, type DocsState } from "../controllers/DocsController";
import {
  WsChatController,
  type WsChatControllerState,
} from "../controllers/ChatController";
import { WikiRender } from "./WikiRender";

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
                  onClick={() => void controllerRef.current.selectFile(filename)}
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
          {!loading && !error && content && (
            <WikiRender content={content} />
          )}
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

// ── ProductChatPanel ──────────────────────────────────────────────────────────

interface ProductChatPanelProps {
  controller?: WsChatController;
}

function ProductChatPanel({ controller: controllerProp }: ProductChatPanelProps) {
  const controllerRef = useRef<WsChatController>(
    controllerProp ?? new WsChatController({ wsEndpoint: "/studio/ws" }),
  );
  const [chatState, setChatState] = useState<WsChatControllerState>(
    controllerRef.current.getState(),
  );
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const ctrl = controllerRef.current;
    const unsub = ctrl.subscribe(setChatState);
    ctrl.connect();
    return () => {
      unsub();
      ctrl.disconnect();
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatState.messages]);

  const submitting = chatState.turnState !== "idle";

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  }

  async function handleSubmit() {
    const text = input.trim();
    if (!text || submitting) return;
    setInput("");
    await controllerRef.current.sendMessage(text);
    textareaRef.current?.focus();
  }

  return (
    <div
      data-testid="product-chat-panel"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--bg-base)",
        color: "var(--fg-1)",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "var(--sp-3) var(--sp-4)",
          borderBottom: "1px solid var(--border-subtle)",
          flexShrink: 0,
          background: "var(--bg-raised)",
        }}
      >
        <span className="label" style={{ color: "var(--fg-1)" }}>
          AGENT — PRODUCT
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            color:
              chatState.connState === "open"
                ? "var(--status-nominal)"
                : "var(--fg-3)",
          }}
        >
          {chatState.connState.toUpperCase()}
        </span>
      </div>

      {/* Message list */}
      <div
        data-testid="product-chat-messages"
        aria-live="polite"
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "var(--sp-3) var(--sp-4)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--sp-2)",
        }}
      >
        {chatState.messages.length === 0 && (
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
            ASK ABOUT THE PRODUCT DOCS.
          </p>
        )}
        {chatState.messages.map((msg) => {
          const isUser = msg.role === "user";
          const accent = isUser ? "var(--accent-cyan)" : "var(--accent-green)";
          return (
            <div
              key={msg.id}
              style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start" }}
            >
              <div
                style={{
                  maxWidth: "85%",
                  padding: "var(--sp-2) var(--sp-3)",
                  background: "var(--bg-raised)",
                  border: "1px solid var(--border-subtle)",
                  borderLeftWidth: 3,
                  borderLeftColor: accent,
                  color: "var(--fg-1)",
                  fontSize: "var(--text-sm)",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  fontFamily: "var(--font-sans)",
                  lineHeight: "var(--lh-relaxed)",
                }}
              >
                {msg.content}
                {msg.streaming && (
                  <span
                    aria-label="streaming"
                    style={{
                      display: "inline-block",
                      width: 6,
                      height: 12,
                      marginLeft: 2,
                      background: "var(--fg-2)",
                      verticalAlign: "text-bottom",
                      animation: "pulse 1s cubic-bezier(0.4, 0, 0.6, 1) infinite",
                    }}
                  />
                )}
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input form */}
      <form
        onSubmit={(e) => { e.preventDefault(); void handleSubmit(); }}
        data-testid="product-chat-form"
        style={{
          padding: "var(--sp-3) var(--sp-4)",
          borderTop: "1px solid var(--border-subtle)",
          background: "var(--bg-raised)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-end", gap: "var(--sp-2)" }}>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="ENTER COMMAND…"
            rows={1}
            disabled={submitting}
            aria-label="Product chat input"
            data-testid="product-chat-input"
            style={{
              flex: 1,
              resize: "none",
              background: "var(--bg-base)",
              border: "1px solid var(--border-subtle)",
              color: "var(--fg-1)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-sm)",
              padding: "var(--sp-2) var(--sp-3)",
              outline: "none",
              opacity: submitting ? 0.5 : 1,
            }}
          />
          <button
            type="submit"
            disabled={submitting || !input.trim()}
            aria-label="Send message"
            data-testid="product-chat-submit"
            style={{
              padding: "var(--sp-2) var(--sp-3)",
              background: "transparent",
              border: "1px solid var(--accent-cyan)",
              color: "var(--accent-cyan)",
              cursor: submitting || !input.trim() ? "not-allowed" : "pointer",
              opacity: submitting || !input.trim() ? 0.4 : 1,
              display: "inline-flex",
              alignItems: "center",
            }}
          >
            <Send size={16} />
          </button>
        </div>
      </form>
    </div>
  );
}

// ── ProductTab root ───────────────────────────────────────────────────────────

interface ProductTabProps {
  docsController?: DocsController;
  chatController?: WsChatController;
}

export function ProductTab({ docsController, chatController }: ProductTabProps) {
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
      <div style={{ flex: 1, minWidth: 0, overflow: "hidden", display: "flex" }}>
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
        <ProductChatPanel controller={chatController} />
      </div>
    </div>
  );
}
