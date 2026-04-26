/**
 * @file studio-ws.ts
 *
 * Bun native WebSocket handler for the Studio Server.
 *
 * Each browser session gets one WebSocket connection. The connection proxies
 * agent turns through the superfield API and steering requests to the dev loop.
 *
 * Frame protocol (browser → server):
 *   { type: 'turn', message: string }     — start an agent turn
 *   { type: 'steer', context: string }    — steer the active session
 *
 * Frame protocol (server → browser):
 *   { type: 'chunk', text: string }       — one chunk of agent output
 *   { type: 'done', sessionId: string, filesChanged: string[] }
 *   { type: 'error', message: string }    — turn error
 *   { type: 'steer-ack', requestId: string }
 */

import { SESSION_KEY } from './claude-session';
import { streamTurn } from './claude-session';

export interface WsData {
  superfieldApiUrl: string;
  logDir?: string;
  /** Abort controller for an in-flight turn; replaced on each new turn. */
  abortController?: AbortController;
  /** Injected streamTurn for tests. */
  _streamTurn?: typeof streamTurn;
  /** Injected fetch for steer proxy (tests). */
  _fetch?: typeof fetch;
}

type InboundFrame =
  | { type: 'turn'; message: string; mode?: string }
  | { type: 'steer'; context: string };

type OutboundFrame =
  | { type: 'chunk'; text: string }
  | { type: 'done'; sessionId: string; filesChanged: string[] }
  | { type: 'error'; message: string }
  | { type: 'steer-ack'; requestId: string };

function send(ws: { send: (data: string) => void }, frame: OutboundFrame): void {
  ws.send(JSON.stringify(frame));
}

export const studioWsHandler = {
  open(_ws: { data: WsData }) {
    // Connection established — nothing to do.
  },

  async message(ws: { data: WsData; send: (data: string) => void }, raw: string | Buffer) {
    let frame: InboundFrame;
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : raw.toString()) as InboundFrame;
    } catch {
      send(ws, { type: 'error', message: 'Invalid JSON frame' });
      return;
    }

    if (frame.type === 'turn') {
      // Cancel any in-flight turn.
      ws.data.abortController?.abort();
      const ac = new AbortController();
      ws.data.abortController = ac;

      const mode = frame.mode === 'question' ? 'question' as const : 'design' as const;

      // Create a custom fetch that respects the abort signal.
      const baseFetch = ws.data._fetch ?? globalThis.fetch;
      const abortableFetch: typeof fetch = (input, init) =>
        baseFetch(input, { ...init, signal: ac.signal });

      const _streamTurn = ws.data._streamTurn ?? streamTurn;
      const stream = _streamTurn(frame.message, SESSION_KEY, ws.data.logDir, mode, abortableFetch);
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let capturedSessionId = SESSION_KEY;
      let filesChanged: string[] = [];

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          let currentEvent = '';
          for (const line of lines) {
            if (line.startsWith('event: ')) {
              currentEvent = line.slice('event: '.length).trim();
            } else if (line.startsWith('data: ')) {
              const data = line.slice('data: '.length);
              if (currentEvent === 'done') {
                try {
                  const parsed = JSON.parse(data) as { filesChanged?: string[] };
                  filesChanged = parsed.filesChanged ?? [];
                } catch { /* ignore */ }
                currentEvent = '';
              } else if (currentEvent === 'error') {
                send(ws, { type: 'error', message: data });
                return;
              } else if (currentEvent === 'session') {
                try {
                  const parsed = JSON.parse(data) as { sessionId?: string };
                  if (parsed.sessionId) capturedSessionId = parsed.sessionId;
                } catch { /* ignore */ }
                currentEvent = '';
              } else {
                send(ws, { type: 'chunk', text: data });
                currentEvent = '';
              }
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          const msg = err instanceof Error ? err.message : String(err);
          send(ws, { type: 'error', message: msg });
        }
        return;
      }

      send(ws, { type: 'done', sessionId: capturedSessionId, filesChanged });
    } else if (frame.type === 'steer') {
      // Proxy steer to the dev-loop API.
      const steerFetch = ws.data._fetch ?? globalThis.fetch;
      try {
        const res = await steerFetch(`${ws.data.superfieldApiUrl}/steer/context`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ context: frame.context }),
        });
        const body = (await res.json()) as { requestId?: string };
        send(ws, { type: 'steer-ack', requestId: body.requestId ?? '' });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        send(ws, { type: 'error', message: `Steer failed: ${msg}` });
      }
    }
  },

  close(ws: { data: WsData }) {
    // Cancel any in-flight fetch when the browser disconnects.
    ws.data.abortController?.abort();
  },
};
