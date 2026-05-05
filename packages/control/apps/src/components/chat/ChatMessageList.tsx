import React, { useEffect, type RefObject } from "react";
import type { ChatMessage } from "../../controllers/ChatController";

export interface ChatMessageListProps {
  messages: ChatMessage[];
  bottomRef: RefObject<HTMLDivElement>;
  emptyState?: React.ReactNode;
}

export function ChatMessageList({
  messages,
  bottomRef,
  emptyState,
}: ChatMessageListProps) {
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, bottomRef]);

  return (
    <div
      data-testid="chat-message-list"
      style={{
        flex: 1,
        overflowY: "auto",
        padding: "var(--sp-3) var(--sp-4)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-2)",
      }}
    >
      {messages.length === 0 && emptyState}
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
  );
}
