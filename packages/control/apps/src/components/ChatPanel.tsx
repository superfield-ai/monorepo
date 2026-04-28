/**
 * @file ChatPanel
 *
 * Left panel of the Studio browser interface. Renders:
 *  - Chat message history
 *  - A three-position composer mode toggle: steer / feature / product
 *  - A chat input field for submitting prompts or steer commands
 *  - A persistent ClusterStatusIndicator at the top
 *
 * The panel speaks to the studio WebSocket controller so the mode toggle can
 * reach the superfield API with the correct transport:
 *  - feature/product → turn frames with mode metadata
 *  - steer → issue-scoped steer frames bound to a selected session
 *
 * Visuals follow the Superfield Control Room design system: near-void
 * backgrounds, sharp 1px borders, mono ALL-CAPS header label, role-coloured
 * message rows (cyan for user, green for assistant).
 */

import React, { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import {
  ClusterStatusIndicator,
  type ClusterStatus,
} from "./ClusterStatusIndicator";
import { WsChatController, type ChatMessage } from "../controllers/ChatController";
import type { DemoIssue } from "./IssueRail";

export type ChatMode = "steer" | "feature" | "product";

export interface ChatState {
  messages: ChatMessage[];
  turnState: "idle" | "streaming" | "error";
}

export interface ChatSessionController {
  subscribe(listener: (state: ChatState) => void): () => void;
  getState(): ChatState;
  sendMessage(text: string, mode?: "design" | "question"): Promise<void>;
  sendSteer(context: string, sessionId: string): Promise<void>;
  clearError(): void;
  connect?: () => void;
  disconnect?: () => void;
}

interface ChatPanelProps {
  /** Current cluster status forwarded from parent SSE consumer */
  clusterStatus?: ClusterStatus;
  /** Override for the cluster events URL (for testing) */
  clusterEventsUrl?: string;
  /** Optional pre-constructed controller instance (for testing) */
  controller?: ChatSessionController;
  /** Controlled composer mode. When omitted, the component manages its own mode. */
  mode?: ChatMode;
  /** Issue currently selected in the adjacent agent rail. */
  selectedIssue?: DemoIssue | null;
  /** Called when the user changes mode via the toggle. */
  onModeChange?: (mode: ChatMode) => void;
  /** Called when the user submits a steer prompt. */
  onSteerSubmit?: (issue: DemoIssue, prompt: string) => void;
}

function modeLabel(mode: ChatMode): string {
  switch (mode) {
    case "steer":
      return "STEER";
    case "feature":
      return "FEATURE";
    case "product":
      return "PRODUCT";
  }
}

function mapMode(mode: ChatMode): "design" | "question" {
  return mode === "product" ? "question" : "design";
}

export function ChatPanel({
  clusterStatus,
  clusterEventsUrl,
  controller: controllerProp,
  mode: modeProp,
  selectedIssue,
  onModeChange,
  onSteerSubmit,
}: ChatPanelProps) {
  const controllerRef = useRef<ChatSessionController>(
    controllerProp ??
      new WsChatController({
        wsEndpoint: "/studio/ws",
      }),
  );

  const [chatState, setChatState] = useState<ChatState>(
    controllerRef.current.getState(),
  );
  const [input, setInput] = useState("");
  const [localMode, setLocalMode] = useState<ChatMode>("feature");
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const mode = modeProp ?? localMode;
  const setMode = onModeChange ?? setLocalMode;
  const steerLocked = Boolean(selectedIssue?.sessionId);

  useEffect(() => {
    const ctrl = controllerRef.current;
    const unsub = ctrl.subscribe(setChatState);
    ctrl.connect?.();
    return () => {
      unsub();
      ctrl.disconnect?.();
    };
  }, []);

  useEffect(() => {
    if (mode === "steer" && !steerLocked) {
      setMode("feature");
    }
  }, [mode, steerLocked, setMode]);

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
    if (mode === "steer") {
      if (!selectedIssue?.sessionId) return;
      onSteerSubmit?.(selectedIssue, text);
      await controllerRef.current.sendSteer(text, selectedIssue.sessionId);
    } else {
      await controllerRef.current.sendMessage(text, mapMode(mode));
    }
    textareaRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit(e as unknown as React.FormEvent);
    }
  }

  function renderModeButton(next: ChatMode) {
    const active = mode === next;
    const disabled = next === "steer" && !steerLocked;
    return (
      <button
        key={next}
        type="button"
        onClick={() => {
          if (disabled) return;
          setMode(next);
        }}
        disabled={disabled}
        className={`rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] transition-colors ${
          active
            ? "border-emerald-400 bg-emerald-400/15 text-emerald-200"
            : "border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
        } ${disabled ? "opacity-40" : ""}`}
      >
        {modeLabel(next)}
      </button>
    );
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
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--sp-3)",
          padding: "var(--sp-3) var(--sp-4)",
          borderBottom: "1px solid var(--border-subtle)",
          flexShrink: 0,
          background: "var(--bg-raised)",
        }}
      >
        <div className="flex min-w-0 flex-col gap-2">
          <span className="label" style={{ color: "var(--fg-1)" }}>
            AGENT — STUDIO
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {renderModeButton("steer")}
            {renderModeButton("feature")}
            {renderModeButton("product")}
          </div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">
            {mode === "steer" && selectedIssue
              ? `Steering issue #${selectedIssue.number}`
              : `Mode ${modeLabel(mode)}`}
          </div>
        </div>
        <ClusterStatusIndicator
          statusOverride={clusterStatus}
          eventsUrl={clusterEventsUrl}
        />
      </div>

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
        {mode === "steer" && selectedIssue && (
          <div
            data-testid="selected-issue-banner"
            className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200"
          >
            Steering locked to issue #{selectedIssue.number} on session{" "}
            {selectedIssue.sessionId.slice(0, 10)}.
          </div>
        )}
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
            SEND A {modeLabel(mode)} PROMPT TO BEGIN.
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
            placeholder={
              mode === "steer" && selectedIssue
                ? `STEER ISSUE #${selectedIssue.number}…`
                : `${modeLabel(mode)} PROMPT…`
            }
            rows={1}
            disabled={submitting || (mode === "steer" && !steerLocked)}
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
            disabled={
              submitting || !input.trim() || (mode === "steer" && !steerLocked)
            }
            aria-label="Send message"
            data-testid="chat-submit"
            style={{
              padding: "var(--sp-2) var(--sp-3)",
              background: "transparent",
              border: "1px solid var(--accent-cyan)",
              color: "var(--accent-cyan)",
              cursor:
                submitting || !input.trim() || (mode === "steer" && !steerLocked)
                  ? "not-allowed"
                  : "pointer",
              opacity:
                submitting || !input.trim() || (mode === "steer" && !steerLocked)
                  ? 0.4
                  : 1,
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
