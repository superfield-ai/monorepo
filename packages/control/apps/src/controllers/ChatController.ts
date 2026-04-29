/**
 * @file ChatController
 *
 * Pure TypeScript controller for the Claude chat panel. Owns message history,
 * API calls, and SSE stream consumption with no React imports.
 *
 * Responsibilities:
 *  - POST a user message to /studio/chat
 *  - Detect streaming (text/event-stream) vs JSON responses
 *  - Accumulate streaming SSE chunks into an assistant message
 *  - Maintain message history and turn state
 *  - Notify subscribers via a callback on every state change
 *
 * Canonical docs: docs/studio-mode.md — "Claude CLI Integration"
 *
 * Browser-native APIs used: fetch, ReadableStream (via Response.body)
 * No React imports.
 */

export type TurnState = "idle" | "streaming" | "error";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** True while content is still streaming in */
  streaming?: boolean;
}

export interface ChatControllerState {
  messages: ChatMessage[];
  turnState: TurnState;
}

export type ChatControllerListener = (state: ChatControllerState) => void;

function createMessageId(): string {
  const cryptoObj = globalThis.crypto as Crypto | undefined;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  const bytes = new Uint8Array(16);
  cryptoObj?.getRandomValues?.(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * ChatController manages the send/receive lifecycle for the Claude chat panel.
 *
 * Usage:
 *   const ctrl = new ChatController({ chatEndpoint: '/studio/chat' });
 *   ctrl.subscribe(setState);
 *   await ctrl.sendMessage('Fix the bug');
 */
export class ChatController {
  private messages: ChatMessage[] = [];
  private turnState: TurnState = "idle";
  private listeners: Set<ChatControllerListener> = new Set();
  private readonly chatEndpoint: string;

  constructor({
    chatEndpoint = "/studio/chat",
  }: { chatEndpoint?: string } = {}) {
    this.chatEndpoint = chatEndpoint;
  }

  /** Register a listener that is called on every state change. */
  subscribe(listener: ChatControllerListener): () => void {
    this.listeners.add(listener);
    // Immediately deliver current state
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  getState(): ChatControllerState {
    return { messages: [...this.messages], turnState: this.turnState };
  }

  /**
   * Send a user message to the chat endpoint and process the response.
   *
   * Handles both streaming (text/event-stream) and JSON (non-streaming)
   * responses. The method is idempotent with respect to the turn state —
   * calling it while a turn is already in progress is a no-op.
   */
  async sendMessage(text: string): Promise<void> {
    if (this.turnState !== "idle" || !text.trim()) return;

    const userMessage: ChatMessage = {
      id: createMessageId(),
      role: "user",
      content: text.trim(),
    };

    this.messages = [...this.messages, userMessage];
    this.turnState = "streaming";
    this.notify();

    const assistantId = createMessageId();

    try {
      const res = await fetch(this.chatEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text.trim() }),
      });

      const contentType = res.headers.get("Content-Type") ?? "";

      if (!res.ok) {
        let message =
          res.status === 401
            ? "Not authenticated — please log in first."
            : `Request failed with status ${res.status}`;

        if (res.status !== 401 && contentType.includes("application/json")) {
          try {
            const body = (await res.json()) as {
              error?: string;
              message?: string;
              detail?: string;
            };
            message = body.error ?? body.message ?? body.detail ?? message;
          } catch {
            // Keep the fallback message if the body cannot be parsed.
          }
        } else if (res.status !== 401 && contentType.length > 0) {
          try {
            const text = (await res.text()).trim();
            if (text) message = text;
          } catch {
            // Keep the fallback message if the body cannot be read.
          }
        }

        throw new Error(message);
      }

      if (contentType.includes("text/event-stream")) {
        // Streaming SSE response — append chunks as they arrive.
        this.messages = [
          ...this.messages,
          { id: assistantId, role: "assistant", content: "", streaming: true },
        ];
        this.notify();

        const reader = res.body?.getReader();
        const decoder = new TextDecoder();

        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            // Parse SSE lines: "data: <text>\n\n"
            for (const line of chunk.split("\n")) {
              if (line.startsWith("data: ")) {
                const data = line.slice(6);
                if (data === "[DONE]") break;
                this.messages = this.messages.map((m) =>
                  m.id === assistantId
                    ? { ...m, content: m.content + data }
                    : m,
                );
                this.notify();
              }
            }
          }
          this.messages = this.messages.map((m) =>
            m.id === assistantId ? { ...m, streaming: false } : m,
          );
        }
      } else {
        // JSON response (fixture server / non-streaming fallback)
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          const message =
            res.status === 401
              ? "Not authenticated — please log in first."
              : (body.error ?? `Server error (HTTP ${res.status})`);
          throw new Error(message);
        }
        const body = (await res.json()) as { reply?: string };
        const reply = body.reply ?? "";
        this.messages = [
          ...this.messages,
          { id: assistantId, role: "assistant", content: reply },
        ];
      }

      this.turnState = "idle";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.messages = [
        ...this.messages,
        {
          id: assistantId,
          role: "assistant",
          content: `(Error: ${message})`,
        },
      ];
      this.turnState = "error";
    }

    this.notify();
  }

  /** Reset error state back to idle so the user can retry. */
  clearError(): void {
    if (this.turnState === "error") {
      this.turnState = "idle";
      this.notify();
    }
  }

  private notify(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}

/**
 * WsChatController — WebSocket-based replacement for ChatController.
 *
 * Connects to GET /studio/ws via the typed `openWebSocket` wrapper so transport
 * drops surface as `AppError` and breadcrumbs in the DebugStore. The controller
 * owns a small reconnect state machine:
 *
 *   idle ─send─▶ connecting ─open─▶ open ─close(unclean)─▶ reconnecting
 *   reconnecting ─backoff exhausted─▶ failed (manual reconnect required)
 *
 * Subscribers see the connection state in `connState` so the UI can render a
 * "Reconnecting…" pill or a "Reconnect now" recovery button.
 */

import { openWebSocket, type WebSocketHandle } from "../lib/net";
import type { AppError } from "../lib/errors";

export type ConnState =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "failed";

export interface WsChatControllerState extends ChatControllerState {
  readonly connState: ConnState;
  readonly reconnectAttempt: number;
  readonly lastError: AppError | null;
}

export type WsChatListener = (state: WsChatControllerState) => void;

export interface WsChatControllerOptions {
  readonly wsEndpoint?: string;
  readonly maxReconnectAttempts?: number;
  /** Backoff schedule in ms; index clamped to last entry. */
  readonly backoffMs?: readonly number[];
  /** Test seam: open the socket synchronously rather than via the typed wrapper. */
  readonly openSocket?: (url: string) => WebSocketHandle;
  /** Test seam: schedule a reconnect timer. */
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

interface WsFrame {
  type: string;
  text?: string;
  sessionId?: string;
  filesChanged?: string[];
  message?: string;
  mode?: string;
}

export class WsChatController {
  private messages: ChatMessage[] = [];
  private turnState: TurnState = "idle";
  private connState: ConnState = "idle";
  private reconnectAttempt = 0;
  private lastError: AppError | null = null;
  private listeners: Set<WsChatListener> = new Set();
  private handle: WebSocketHandle | null = null;
  private pendingAssistantId: string | null = null;
  private reconnectTimer: unknown = null;
  private manuallyClosed = false;
  private readonly wsEndpoint: string;
  private readonly maxReconnectAttempts: number;
  private readonly backoffMs: readonly number[];
  private readonly openSocket: (url: string) => WebSocketHandle;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor({
    wsEndpoint = "/studio/ws",
    maxReconnectAttempts = 5,
    backoffMs = [500, 1000, 2000, 4000, 8000],
    openSocket,
    setTimer,
    clearTimer,
  }: WsChatControllerOptions = {}) {
    this.wsEndpoint = wsEndpoint;
    this.maxReconnectAttempts = maxReconnectAttempts;
    this.backoffMs = backoffMs;
    this.openSocket =
      openSocket ??
      ((url) =>
        openWebSocket({
          url,
          onOpen: () => this.handleOpen(),
          onMessage: (ev) => this.handleMessage(ev as MessageEvent<string>),
          onClose: (ev) => this.handleClose(ev),
          onError: (e) => this.handleError(e),
        }));
    this.setTimer = setTimer ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
    this.clearTimer =
      clearTimer ??
      ((h) => {
        if (h !== null && h !== undefined) {
          globalThis.clearTimeout(h as ReturnType<typeof setTimeout>);
        }
      });
  }

  subscribe(listener: WsChatListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  getState(): WsChatControllerState {
    return {
      messages: [...this.messages],
      turnState: this.turnState,
      connState: this.connState,
      reconnectAttempt: this.reconnectAttempt,
      lastError: this.lastError,
    };
  }

  connect(): void {
    if (
      this.connState === "connecting" ||
      this.connState === "open" ||
      this.connState === "reconnecting"
    ) {
      return;
    }
    this.openConnection();
  }

  /** Manually retry after the reconnect budget has been exhausted. */
  reconnectNow(): void {
    if (this.connState === "open" || this.connState === "connecting") return;
    this.cancelReconnect();
    this.reconnectAttempt = 0;
    this.lastError = null;
    this.openConnection();
  }

  disconnect(): void {
    this.manuallyClosed = true;
    this.cancelReconnect();
    if (this.handle) {
      this.handle.close();
      this.handle = null;
    }
    this.connState = "idle";
    this.notify();
  }

  async sendMessage(
    text: string,
    mode: "design" | "question" = "design",
  ): Promise<void> {
    if (this.turnState !== "idle" || !text.trim()) return;

    if (this.connState === "idle" || this.connState === "failed") {
      this.connect();
    }

    if (this.connState !== "open") {
      const opened = await this.waitForOpen();
      if (!opened) {
        this.turnState = "error";
        this.notify();
        return;
      }
    }

    const userMessage: ChatMessage = {
      id: createMessageId(),
      role: "user",
      content: text.trim(),
    };
    this.messages = [...this.messages, userMessage];
    this.turnState = "streaming";

    const assistantId = createMessageId();
    this.pendingAssistantId = assistantId;
    this.messages = [
      ...this.messages,
      { id: assistantId, role: "assistant", content: "", streaming: true },
    ];
    this.notify();

    this.handle?.send(
      JSON.stringify({ type: "turn", message: text.trim(), mode }),
    );
  }

  async sendSteer(context: string, sessionId: string): Promise<void> {
    if (this.turnState !== "idle" || !context.trim() || !sessionId.trim()) {
      return;
    }

    if (this.connState === "idle" || this.connState === "failed") {
      this.connect();
    }

    if (this.connState !== "open") {
      const opened = await this.waitForOpen();
      if (!opened) {
        this.turnState = "error";
        this.notify();
        return;
      }
    }

    this.messages = [
      ...this.messages,
      {
        id: createMessageId(),
        role: "user",
        content: context.trim(),
      },
    ];
    this.notify();

    this.handle?.send(
      JSON.stringify({
        type: "steer",
        context: context.trim(),
        sessionId: sessionId.trim(),
      }),
    );
  }

  clearError(): void {
    if (this.turnState === "error") {
      this.turnState = "idle";
      this.notify();
    }
  }

  private openConnection(): void {
    this.manuallyClosed = false;
    this.connState = this.reconnectAttempt > 0 ? "reconnecting" : "connecting";
    this.notify();

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${location.host}${this.wsEndpoint}`;
    this.handle = this.openSocket(url);
  }

  private handleOpen(): void {
    this.connState = "open";
    this.reconnectAttempt = 0;
    this.lastError = null;
    this.notify();
  }

  private handleMessage(event: MessageEvent<string>): void {
    let frame: WsFrame;
    try {
      frame = JSON.parse(event.data) as WsFrame;
    } catch {
      return;
    }
    if (frame.type === "chunk" && this.pendingAssistantId) {
      this.messages = this.messages.map((m) =>
        m.id === this.pendingAssistantId
          ? { ...m, content: m.content + (frame.text ?? "") }
          : m,
      );
      this.notify();
    } else if (frame.type === "done") {
      if (this.pendingAssistantId) {
        this.messages = this.messages.map((m) =>
          m.id === this.pendingAssistantId ? { ...m, streaming: false } : m,
        );
      }
      this.pendingAssistantId = null;
      this.turnState = "idle";
      this.notify();
    } else if (frame.type === "error") {
      if (this.pendingAssistantId) {
        this.messages = this.messages.map((m) =>
          m.id === this.pendingAssistantId
            ? {
                ...m,
                content: `(Error: ${frame.message ?? "unknown"})`,
                streaming: false,
              }
            : m,
        );
      }
      this.pendingAssistantId = null;
      this.turnState = "error";
      this.notify();
    }
  }

  private handleClose(ev: CloseEvent): void {
    this.handle = null;
    if (this.manuallyClosed || ev.wasClean) {
      this.connState = "idle";
      this.notify();
      return;
    }
    this.scheduleReconnect();
  }

  private handleError(error: AppError): void {
    this.lastError = error;
    if (this.pendingAssistantId) {
      // Mid-turn drop — surface as a turn error so the user sees it.
      this.turnState = "error";
    }
    this.notify();
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempt >= this.maxReconnectAttempts) {
      this.connState = "failed";
      this.notify();
      return;
    }
    this.connState = "reconnecting";
    const delayIdx = Math.min(this.reconnectAttempt, this.backoffMs.length - 1);
    const delay = this.backoffMs[delayIdx] ?? 1000;
    this.reconnectAttempt += 1;
    this.notify();
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      this.openConnection();
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private async waitForOpen(timeoutMs = 5000): Promise<boolean> {
    if (this.connState === "open") return true;
    return await new Promise<boolean>((resolve) => {
      const unsub = this.subscribe((state) => {
        if (state.connState === "open") {
          unsub();
          resolve(true);
        } else if (state.connState === "failed") {
          unsub();
          resolve(false);
        }
      });
      this.setTimer(() => {
        unsub();
        resolve(this.connState === "open");
      }, timeoutMs);
    });
  }

  private notify(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
