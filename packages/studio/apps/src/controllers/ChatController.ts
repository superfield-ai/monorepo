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

export type TurnState = 'idle' | 'streaming' | 'error';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** True while content is still streaming in */
  streaming?: boolean;
}

export interface ChatControllerState {
  messages: ChatMessage[];
  turnState: TurnState;
}

export type ChatControllerListener = (state: ChatControllerState) => void;

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
  private turnState: TurnState = 'idle';
  private listeners: Set<ChatControllerListener> = new Set();
  private readonly chatEndpoint: string;

  constructor({ chatEndpoint = '/studio/chat' }: { chatEndpoint?: string } = {}) {
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
    if (this.turnState !== 'idle' || !text.trim()) return;

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text.trim(),
    };

    this.messages = [...this.messages, userMessage];
    this.turnState = 'streaming';
    this.notify();

    const assistantId = crypto.randomUUID();

    try {
      const res = await fetch(this.chatEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text.trim() }),
      });

      const contentType = res.headers.get('Content-Type') ?? '';

      if (contentType.includes('text/event-stream')) {
        // Streaming SSE response — append chunks as they arrive.
        this.messages = [
          ...this.messages,
          { id: assistantId, role: 'assistant', content: '', streaming: true },
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
            for (const line of chunk.split('\n')) {
              if (line.startsWith('data: ')) {
                const data = line.slice(6);
                if (data === '[DONE]') break;
                this.messages = this.messages.map((m) =>
                  m.id === assistantId ? { ...m, content: m.content + data } : m,
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
        const body = (await res.json()) as { reply?: string };
        const reply = body.reply ?? '';
        this.messages = [
          ...this.messages,
          { id: assistantId, role: 'assistant', content: reply },
        ];
      }

      this.turnState = 'idle';
    } catch {
      this.messages = [
        ...this.messages,
        {
          id: assistantId,
          role: 'assistant',
          content: '(Error: could not reach studio server)',
        },
      ];
      this.turnState = 'error';
    }

    this.notify();
  }

  /** Reset error state back to idle so the user can retry. */
  clearError(): void {
    if (this.turnState === 'error') {
      this.turnState = 'idle';
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
 * Connects to GET /studio/ws (Bun WebSocket upgrade). Messages are sent as
 * JSON frames. Chunks arrive as { type: 'chunk', text } frames. The turn
 * completes with { type: 'done', sessionId, filesChanged }.
 */
export class WsChatController {
  private messages: ChatMessage[] = [];
  private turnState: TurnState = 'idle';
  private listeners: Set<ChatControllerListener> = new Set();
  private ws: WebSocket | null = null;
  private readonly wsEndpoint: string;
  private pendingAssistantId: string | null = null;

  constructor({ wsEndpoint = '/studio/ws' }: { wsEndpoint?: string } = {}) {
    this.wsEndpoint = wsEndpoint;
  }

  subscribe(listener: ChatControllerListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  getState(): ChatControllerState {
    return { messages: [...this.messages], turnState: this.turnState };
  }

  connect(): void {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) return;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}${this.wsEndpoint}`;
    this.ws = new WebSocket(url);

    this.ws.onmessage = (event: MessageEvent<string>) => {
      let frame: { type: string; text?: string; sessionId?: string; filesChanged?: string[]; message?: string };
      try {
        frame = JSON.parse(event.data) as typeof frame;
      } catch {
        return;
      }

      if (frame.type === 'chunk' && this.pendingAssistantId) {
        this.messages = this.messages.map((m) =>
          m.id === this.pendingAssistantId
            ? { ...m, content: m.content + (frame.text ?? '') }
            : m,
        );
        this.notify();
      } else if (frame.type === 'done') {
        if (this.pendingAssistantId) {
          this.messages = this.messages.map((m) =>
            m.id === this.pendingAssistantId ? { ...m, streaming: false } : m,
          );
        }
        this.pendingAssistantId = null;
        this.turnState = 'idle';
        this.notify();
      } else if (frame.type === 'error') {
        if (this.pendingAssistantId) {
          this.messages = this.messages.map((m) =>
            m.id === this.pendingAssistantId
              ? { ...m, content: `(Error: ${frame.message ?? 'unknown'})`, streaming: false }
              : m,
          );
        }
        this.pendingAssistantId = null;
        this.turnState = 'error';
        this.notify();
      }
    };

    this.ws.onerror = () => {
      this.turnState = 'error';
      this.notify();
    };
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }

  async sendMessage(text: string): Promise<void> {
    if (this.turnState !== 'idle' || !text.trim()) return;

    this.connect();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Wait for connection.
      await new Promise<void>((resolve, reject) => {
        const ws = this.ws!;
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error('WebSocket connection failed'));
        setTimeout(() => reject(new Error('WebSocket connection timeout')), 5000);
      }).catch(() => {
        this.turnState = 'error';
        this.notify();
        return;
      });
    }

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text.trim(),
    };
    this.messages = [...this.messages, userMessage];
    this.turnState = 'streaming';

    const assistantId = crypto.randomUUID();
    this.pendingAssistantId = assistantId;
    this.messages = [
      ...this.messages,
      { id: assistantId, role: 'assistant', content: '', streaming: true },
    ];
    this.notify();

    this.ws!.send(JSON.stringify({ type: 'turn', message: text.trim() }));
  }

  clearError(): void {
    if (this.turnState === 'error') {
      this.turnState = 'idle';
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
