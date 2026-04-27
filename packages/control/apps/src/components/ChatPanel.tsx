/**
 * @file ChatPanel
 *
 * Left panel of the Studio browser interface. Renders:
 *  - Chat message history (user messages + streamed Claude responses)
 *  - A chat input field for submitting new messages
 *  - A persistent ClusterStatusIndicator at the top
 *
 * All API calls and SSE streaming are delegated to ChatController.
 * This component contains no fetch() calls or EventSource instances.
 *
 * Visuals follow the Superfield Control Room design system: near-void
 * backgrounds, sharp 1px borders, mono ALL-CAPS header label, role-coloured
 * message rows (cyan for user, green for assistant). All `data-testid`
 * values and event handlers are preserved.
 *
 * Canonical docs: docs/studio-mode.md — "Browser Interface", "Claude CLI Integration"
 */

import React, { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import {
  ClusterStatusIndicator,
  type ClusterStatus,
} from "./ClusterStatusIndicator";
import { OAuthPanel } from "./OAuthPanel";
import {
  ChatController,
  type ChatControllerState,
} from "../controllers/ChatController";

interface ChatPanelProps {
  /** Current cluster status forwarded from parent SSE consumer */
  clusterStatus?: ClusterStatus;
  /** Override for the cluster events URL (for testing) */
  clusterEventsUrl?: string;
  /** POST endpoint for chat messages; defaults to /studio/chat */
  chatEndpoint?: string;
  /** Optional pre-constructed controller instance (for testing) */
  controller?: ChatController;
}

/**
 * ChatPanel renders the Claude chat sidebar.
 *
 * Behaviour:
 * - User submits a message → delegated to ChatController → POST to chatEndpoint
 * - ChatController detects Content-Type: text/event-stream and appends chunks
 * - ChatController notifies this component via subscribe() on every state change
 */
export function ChatPanel({
  clusterStatus,
  clusterEventsUrl,
  chatEndpoint = "/studio/chat",
  controller: controllerProp,
}: ChatPanelProps) {
  const controllerRef = useRef<ChatController>(
    controllerProp ?? new ChatController({ chatEndpoint }),
  );

  const [chatState, setChatState] = useState<ChatControllerState>(
    controllerRef.current.getState(),
  );
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Subscribe to controller state changes
  useEffect(() => {
    const unsub = controllerRef.current.subscribe(setChatState);
    return unsub;
  }, []);

  // Auto-scroll to bottom when messages change.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatState.messages]);

  const submitting = chatState.turnState !== "idle";
  const { messages } = chatState;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || submitting) return;
    setInput("");
    await controllerRef.current.sendMessage(text);
    textareaRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Submit on Enter without Shift; allow Shift+Enter for newlines.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit(e as unknown as React.FormEvent);
    }
  }

  return (
    <div
      data-testid="chat-panel"
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
          AGENT — STUDIO
        </span>
        <ClusterStatusIndicator
          statusOverride={clusterStatus}
          eventsUrl={clusterEventsUrl}
        />
      </div>

      {/* OAuth Connection Panel */}
      <OAuthPanel />

      {/* Message list */}
      <div
        data-testid="chat-messages"
        aria-live="polite"
        aria-label="Chat messages"
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "var(--sp-3) var(--sp-4)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--sp-2)",
        }}
      >
        {messages.length === 0 && (
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
            SEND A MESSAGE TO BEGIN.
          </p>
        )}
        {messages.map((msg) => {
          const isUser = msg.role === "user";
          const accent = isUser ? "var(--accent-cyan)" : "var(--accent-green)";
          return (
            <div
              key={msg.id}
              data-testid={`message-${msg.role}`}
              style={{
                display: "flex",
                justifyContent: isUser ? "flex-end" : "flex-start",
              }}
            >
              <div
                aria-label={isUser ? "Your message" : "Claude response"}
                style={{
                  maxWidth: "85%",
                  padding: "var(--sp-2) var(--sp-3)",
                  background: "var(--bg-raised)",
                  borderLeft: `3px solid ${accent}`,
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
                      animation:
                        "pulse 1s cubic-bezier(0.4, 0, 0.6, 1) infinite",
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
        onSubmit={(e) => void handleSubmit(e)}
        data-testid="chat-form"
        style={{
          padding: "var(--sp-3) var(--sp-4)",
          borderTop: "1px solid var(--border-subtle)",
          background: "var(--bg-raised)",
          flexShrink: 0,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            gap: "var(--sp-2)",
          }}
        >
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="ENTER COMMAND…"
            rows={1}
            disabled={submitting}
            aria-label="Chat input"
            data-testid="chat-input"
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
            data-testid="chat-submit"
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
