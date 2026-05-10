/**
 * @file ControlChat
 *
 * Root panel for the Studio browser interface. Renders commit history with
 * rollback buttons and a chat input for Claude messages.
 *
 * All API calls are delegated to ChatController and CommitController.
 * This component contains no fetch() calls or stream logic.
 *
 * Canonical docs: docs/studio-mode.md — "Claude CLI Integration", "Rollback"
 *
 * @deprecated C-10 cleanup (#272): This file is scheduled for deletion once
 * the import graph is verified clean (see dev-scout #279). As of the scout
 * pass, zero importers of ControlChat exist in packages/control/apps/src
 * outside this file itself. The only active test file that imports this
 * component is tests/component/control-chat.test.tsx — that file must be
 * cleaned up or removed as part of #272.
 */

import React, { useState, useEffect, useRef } from "react";
import {
  MessageSquare,
  RotateCcw,
  Send,
  GitCommit,
  Loader,
} from "lucide-react";
import {
  ChatController,
  type ChatControllerState,
} from "../controllers/ChatController";
import {
  CommitController,
  type CommitControllerState,
} from "../controllers/CommitController";

/**
 * Format an ISO 8601 timestamp into a human-readable relative or absolute string.
 */
function formatTimestamp(iso: string): string {
  try {
    const date = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

interface ControlChatProps {
  fixtureId?: string;
  /** Optional pre-constructed controller instances (for testing) */
  chatController?: ChatController;
  commitController?: CommitController;
}

type StatusState = "loading" | "ready" | "error";

interface ControlInfo {
  active: boolean;
  sessionId?: string;
  branch?: string;
}

export function ControlChat({
  fixtureId,
  chatController: chatControllerProp,
  commitController: commitControllerProp,
}: ControlChatProps = {}) {
  const chatControllerRef = useRef<ChatController>(
    chatControllerProp ??
      new ChatController({
        chatEndpoint: fixtureId
          ? `/studio/chat?fixtureId=${encodeURIComponent(fixtureId)}`
          : "/studio/chat",
      }),
  );
  const commitControllerRef = useRef<CommitController>(
    commitControllerProp ?? new CommitController({ fixtureId }),
  );

  const [studioInfo, setControlInfo] = useState<ControlInfo>({ active: false });
  const [statusState, setStatusState] = useState<StatusState>("loading");
  const [chatState, setChatState] = useState<ChatControllerState>(
    chatControllerRef.current.getState(),
  );
  const [commitState, setCommitState] = useState<CommitControllerState>(
    commitControllerRef.current.getState(),
  );
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Fetch initial studio status
  useEffect(() => {
    void (async () => {
      try {
        const info = await commitControllerRef.current.fetchStatus();
        setControlInfo({
          active: info.active,
          sessionId: info.sessionId,
          branch: info.branch,
        });
        setStatusState("ready");
      } catch {
        setStatusState("error");
      }
    })();
  }, []);

  // Subscribe to controller state
  useEffect(() => {
    const unsubChat = chatControllerRef.current.subscribe(setChatState);
    const unsubCommit = commitControllerRef.current.subscribe(setCommitState);
    return () => {
      unsubChat();
      unsubCommit();
    };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatState.messages]);

  // After each chat turn completes (streaming done), refresh commit list
  const prevTurnState = useRef(chatState.turnState);
  useEffect(() => {
    if (
      prevTurnState.current === "streaming" &&
      chatState.turnState === "idle"
    ) {
      void commitControllerRef.current.fetchStatus().then((info) => {
        setControlInfo({
          active: info.active,
          sessionId: info.sessionId,
          branch: info.branch,
        });
      });
    }
    prevTurnState.current = chatState.turnState;
  }, [chatState.turnState]);

  async function send() {
    const text = input.trim();
    if (!text || chatState.turnState === "streaming") return;
    if (chatState.turnState === "error") {
      chatControllerRef.current.clearError();
    }
    setInput("");
    await chatControllerRef.current.sendMessage(text);
  }

  async function rollback(hash: string) {
    if (
      !confirm(
        `ROLLBACK ${hash.slice(0, 7)} — CONFIRM. Commits after this point will be lost.`,
      )
    )
      return;
    await commitControllerRef.current.rollback(hash);
  }

  async function resetSession() {
    try {
      await chatControllerRef.current.resetSession();
    } catch (err) {
      console.error("[control-chat] reset session failed:", err);
    }
  }

  const loading = chatState.turnState === "streaming";
  const { messages } = chatState;
  const { commits, timeline, error } = commitState;

  if (statusState === "error") {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center p-6">
        <div className="w-12 h-12 rounded-xl bg-red-50 border border-red-200 shadow-sm flex items-center justify-center mb-4">
          <MessageSquare className="text-red-300" size={20} />
        </div>
        <p className="text-sm text-zinc-700 font-medium">
          Studio mode is unavailable right now.
        </p>
        <p className="text-xs text-zinc-500 mt-2">
          Try reloading the page or restarting studio mode.
        </p>
      </div>
    );
  }

  if (statusState !== "ready" || !studioInfo.active) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center p-6">
        <div className="w-12 h-12 rounded-xl bg-white border border-zinc-200 shadow-sm flex items-center justify-center mb-4">
          <MessageSquare className="text-zinc-300" size={20} />
        </div>
        <p className="text-sm text-zinc-500 font-medium">
          Studio mode is not active.
          <br />
          Run{" "}
          <code className="font-mono text-xs bg-zinc-100 px-1 rounded">
            bun run studio
          </code>{" "}
          to begin.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Timeline view — checkpoint history with timestamps */}
      {(timeline.length > 0 || commits.length > 0) && (
        <div
          className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 shrink-0"
          data-testid="timeline-view"
        >
          <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">
            Timeline
          </p>
          <div className="flex flex-col gap-1 max-h-36 overflow-y-auto">
            {(timeline.length > 0 ? timeline : commits).map((c) => (
              <div
                key={c.hash}
                className="flex items-center gap-2 group"
                data-testid="timeline-entry"
              >
                <GitCommit size={12} className="text-zinc-300 shrink-0" />
                <div className="flex flex-col flex-1 min-w-0">
                  <span
                    className="text-xs text-zinc-600 truncate"
                    data-testid="timeline-summary"
                  >
                    {c.message}
                  </span>
                  {"timestamp" in c && c.timestamp && (
                    <span
                      className="text-[10px] text-zinc-400"
                      data-testid="timeline-timestamp"
                    >
                      {formatTimestamp(c.timestamp)}
                    </span>
                  )}
                </div>
                <button
                  onClick={() => void rollback(c.hash)}
                  aria-label="Rollback commit"
                  className="opacity-0 group-hover:opacity-100 transition-opacity text-xs text-red-400 hover:text-red-600 shrink-0 flex items-center gap-1"
                >
                  <RotateCcw size={10} />
                  revert
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => void resetSession()}
            className="inline-flex items-center gap-1 rounded-full border border-zinc-200 px-3 py-1 text-[10px] font-mono uppercase tracking-[0.2em] text-zinc-500 hover:border-zinc-300 hover:text-zinc-700"
          >
            <RotateCcw size={10} />
            Reset session
          </button>
        </div>
        {messages.length === 0 && (
          <div className="flex-1 flex flex-col items-center justify-center text-center">
            <p className="text-xs text-zinc-400">
              Session <span className="font-mono">{studioInfo.sessionId}</span>
              <br />
              Describe what you&apos;d like to change.
            </p>
          </div>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${
                m.role === "user"
                  ? "bg-indigo-600 text-white"
                  : "bg-white border border-zinc-200 text-zinc-800"
              }`}
            >
              <p className="whitespace-pre-wrap">{m.content}</p>
              {m.streaming && (
                <span
                  className="inline-block w-1.5 h-3 ml-0.5 bg-zinc-400 animate-pulse align-text-bottom"
                  aria-label="streaming"
                />
              )}
            </div>
          </div>
        ))}
        {loading && messages[messages.length - 1]?.role !== "assistant" && (
          <div className="flex justify-start">
            <div
              aria-label="Studio response pending"
              className="bg-white border border-zinc-200 rounded-xl px-3 py-2"
            >
              <Loader size={14} className="text-zinc-400 animate-spin" />
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-4 bg-white border-t border-zinc-200 shrink-0">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && void send()}
            placeholder="Describe a change..."
            disabled={loading}
            className="flex-1 bg-zinc-50 border border-zinc-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-shadow placeholder:text-zinc-400 disabled:opacity-50"
          />
          <button
            onClick={() => void send()}
            disabled={loading || !input.trim()}
            aria-label="Send message"
            className="p-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white rounded-xl transition-colors"
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
