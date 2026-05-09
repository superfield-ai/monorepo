/**
 * @file WsChat
 *
 * Composed chat panel that wires a WsChatController to the three chat
 * primitives: <ChatPanelHeader>, <ChatMessageList>, <ChatComposer>.
 *
 * Owns controller lifecycle: creates one if not injected, connects on mount,
 * disconnects on unmount. Maps controller state into primitive props:
 *  - turnState === "streaming"  →  ChatComposer disabled
 *  - turnState === "error"      →  clearError() before sendMessage on submit
 *  - messages                   →  ChatMessageList
 */

import React, { useEffect, useRef, useState, type ReactNode } from "react";
import { ChatPanelHeader } from "./ChatPanelHeader";
import { ChatMessageList } from "./ChatMessageList";
import { ChatComposer } from "./ChatComposer";
import {
  WsChatController,
  type WsChatControllerState,
} from "../../controllers/ChatController";

export interface WsChatProps {
  /** Optional pre-constructed controller instance (for testing or composition). */
  controller?: WsChatController;
  /** Header label rendered in mono ALL-CAPS. */
  label?: string;
  /** WebSocket endpoint forwarded to a freshly constructed controller. */
  wsEndpoint?: string;
  /** Optional right-side actions slot rendered in the header. */
  actions?: ReactNode;
}

export function WsChat({
  controller: controllerProp,
  label = "AGENT — STUDIO",
  wsEndpoint,
  actions,
}: WsChatProps) {
  const controllerRef = useRef<WsChatController>(
    controllerProp ?? new WsChatController({ wsEndpoint }),
  );

  const [chatState, setChatState] = useState<WsChatControllerState>(
    controllerRef.current.getState(),
  );
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctrl = controllerRef.current;
    const unsub = ctrl.subscribe(setChatState);
    ctrl.connect?.();
    return () => {
      unsub();
      ctrl.disconnect?.();
    };
  }, []);

  const submitting = chatState.turnState === "streaming";

  function handleSubmit() {
    const text = input.trim();
    if (!text || submitting) return;
    if (chatState.turnState === "error") {
      controllerRef.current.clearError();
    }
    setInput("");
    void controllerRef.current.sendMessage(text);
  }

  async function handleResetSession() {
    try {
      await controllerRef.current.resetSession();
    } catch (err) {
      console.error("[ws-chat] reset session failed:", err);
    }
  }

  const resetButton = (
    <button
      type="button"
      onClick={() => void handleResetSession()}
      className="self-start rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
    >
      Reset session
    </button>
  );

  const headerActions =
    actions === undefined ? (
      resetButton
    ) : (
      <>
        {actions}
        {resetButton}
      </>
    );

  const emptyState = (
    <p
      data-testid="ws-chat-empty"
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
      SEND A PROMPT TO BEGIN.
    </p>
  );

  return (
    <div
      data-testid="ws-chat"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--bg-base)",
        color: "var(--fg-1)",
      }}
    >
      <ChatPanelHeader label={label} actions={headerActions} />
      <ChatMessageList
        messages={chatState.messages}
        bottomRef={bottomRef}
        emptyState={emptyState}
      />
      <ChatComposer
        value={input}
        onChange={setInput}
        onSubmit={handleSubmit}
        disabled={submitting}
      />
    </div>
  );
}
