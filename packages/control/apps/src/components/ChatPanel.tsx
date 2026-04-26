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
 * Canonical docs: docs/studio-mode.md — "Browser Interface", "Claude CLI Integration"
 */

import React, { useEffect, useRef, useState } from 'react';
import { Send } from 'lucide-react';
import { ClusterStatusIndicator, type ClusterStatus } from './ClusterStatusIndicator';
import { OAuthPanel } from './OAuthPanel';
import { ChatController, type ChatControllerState } from '../controllers/ChatController';

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
  chatEndpoint = '/studio/chat',
  controller: controllerProp,
}: ChatPanelProps) {
  const controllerRef = useRef<ChatController>(
    controllerProp ?? new ChatController({ chatEndpoint }),
  );

  const [chatState, setChatState] = useState<ChatControllerState>(
    controllerRef.current.getState(),
  );
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Subscribe to controller state changes
  useEffect(() => {
    const unsub = controllerRef.current.subscribe(setChatState);
    return unsub;
  }, []);

  // Auto-scroll to bottom when messages change.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatState.messages]);

  const submitting = chatState.turnState !== 'idle';
  const { messages } = chatState;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || submitting) return;
    setInput('');
    await controllerRef.current.sendMessage(text);
    textareaRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Submit on Enter without Shift; allow Shift+Enter for newlines.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit(e as unknown as React.FormEvent);
    }
  }

  return (
    <div className="flex flex-col h-full bg-zinc-900 text-zinc-100" data-testid="chat-panel">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700 shrink-0">
        <span className="text-sm font-semibold text-zinc-100">Claude Chat</span>
        <ClusterStatusIndicator statusOverride={clusterStatus} eventsUrl={clusterEventsUrl} />
      </div>

      {/* OAuth Connection Panel */}
      <OAuthPanel />

      {/* Message list */}
      <div
        className="flex-1 overflow-y-auto px-4 py-3 space-y-3"
        data-testid="chat-messages"
        aria-live="polite"
        aria-label="Chat messages"
      >
        {messages.length === 0 && (
          <p className="text-xs text-zinc-500 text-center mt-8">
            Send a message to Claude to get started.
          </p>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            data-testid={`message-${msg.role}`}
          >
            <div
              className={`max-w-[85%] px-3 py-2 rounded-xl text-sm whitespace-pre-wrap break-words ${
                msg.role === 'user'
                  ? 'bg-indigo-600 text-white rounded-br-sm'
                  : 'bg-zinc-800 text-zinc-100 rounded-bl-sm'
              }`}
              aria-label={msg.role === 'user' ? 'Your message' : 'Claude response'}
            >
              {msg.content}
              {msg.streaming && (
                <span
                  className="inline-block w-1.5 h-3 ml-0.5 bg-zinc-400 animate-pulse align-text-bottom"
                  aria-label="streaming"
                />
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input form */}
      <form
        onSubmit={(e) => void handleSubmit(e)}
        className="px-4 py-3 border-t border-zinc-700 shrink-0"
        data-testid="chat-form"
      >
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask Claude…"
            rows={1}
            disabled={submitting}
            className="flex-1 resize-none rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-100 placeholder-zinc-500 px-3 py-2 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
            aria-label="Chat input"
            data-testid="chat-input"
          />
          <button
            type="submit"
            disabled={submitting || !input.trim()}
            className="p-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white transition-colors"
            aria-label="Send message"
            data-testid="chat-submit"
          >
            <Send size={16} />
          </button>
        </div>
      </form>
    </div>
  );
}
