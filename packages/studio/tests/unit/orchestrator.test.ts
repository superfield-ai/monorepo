import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleOrchestratorRequest,
  _resetDevLoop,
  _setDevLoop,
} from '../../src/orchestrator';
import { DevLoopProcess } from '../../src/dev-loop-process';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(method: string, pathname: string, body?: object): Request {
  const url = `http://localhost${pathname}`;
  if (body) {
    return new Request(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  return new Request(url, { method });
}

function makeUrl(pathname: string): URL {
  return new URL(`http://localhost${pathname}`);
}

function makeFakeLoop(state = 'stopped' as Parameters<DevLoopProcess['status']>[never], apiReachable = false) {
  const logs: string[] = [];
  return {
    status: vi.fn(() => state),
    pid: vi.fn(() => undefined as number | undefined),
    logs: vi.fn(() => [...logs]),
    isApiReachable: vi.fn().mockResolvedValue(apiReachable),
    spawn: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    detectExternalProcess: vi.fn().mockResolvedValue(undefined),
    _pushLog: (line: string) => logs.push(line),
  } as unknown as DevLoopProcess & { _pushLog: (l: string) => void };
}

const API_URL = 'http://127.0.0.1:7837';

beforeEach(() => {
  _resetDevLoop();
});

// ── Non-matching path ─────────────────────────────────────────────────────────

describe('non-matching path', () => {
  it('/something-else → returns null', async () => {
    const req = makeRequest('GET', '/something-else');
    const res = await handleOrchestratorRequest(req, makeUrl('/something-else'), API_URL);
    expect(res).toBeNull();
  });

  it('/orchestratorbadpath → returns null', async () => {
    const req = makeRequest('GET', '/orchestratorbadpath');
    const res = await handleOrchestratorRequest(req, makeUrl('/orchestratorbadpath'), API_URL);
    expect(res).toBeNull();
  });
});

// ── GET /orchestrator/status ──────────────────────────────────────────────────

describe('GET /orchestrator/status', () => {
  it('initial state: process stopped, pid null, apiReachable false, uptimeMs 0', async () => {
    const loop = makeFakeLoop('stopped', false);
    _setDevLoop(loop);

    const req = makeRequest('GET', '/orchestrator/status');
    const res = await handleOrchestratorRequest(req, makeUrl('/orchestrator/status'), API_URL);
    expect(res?.status).toBe(200);

    const body = await res!.json() as { process: string; pid: null; apiReachable: boolean; uptimeMs: number };
    expect(body.process).toBe('stopped');
    expect(body.pid).toBeNull();
    expect(body.apiReachable).toBe(false);
    expect(body.uptimeMs).toBe(0);
  });

  it('running process: includes pid and apiReachable true', async () => {
    const loop = makeFakeLoop('running', true);
    loop.pid = vi.fn(() => 9999);
    _setDevLoop(loop);

    const req = makeRequest('GET', '/orchestrator/status');
    const res = await handleOrchestratorRequest(req, makeUrl('/orchestrator/status'), API_URL);
    const body = await res!.json() as { process: string; pid: number; apiReachable: boolean };
    expect(body.process).toBe('running');
    expect(body.pid).toBe(9999);
    expect(body.apiReachable).toBe(true);
  });
});

// ── POST /orchestrator/start ──────────────────────────────────────────────────

describe('POST /orchestrator/start', () => {
  it('missing repo → 400', async () => {
    _setDevLoop(makeFakeLoop('stopped'));
    const req = makeRequest('POST', '/orchestrator/start', {});
    const res = await handleOrchestratorRequest(req, makeUrl('/orchestrator/start'), API_URL);
    expect(res?.status).toBe(400);
    const body = await res!.json() as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('repo is required');
  });

  it('already running → 409 conflict', async () => {
    _setDevLoop(makeFakeLoop('running'));
    const req = makeRequest('POST', '/orchestrator/start', { repo: '/app' });
    const res = await handleOrchestratorRequest(req, makeUrl('/orchestrator/start'), API_URL);
    expect(res?.status).toBe(409);
    const body = await res!.json() as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toContain('already');
  });

  it('already starting → 409 conflict', async () => {
    _setDevLoop(makeFakeLoop('starting'));
    const req = makeRequest('POST', '/orchestrator/start', { repo: '/app' });
    const res = await handleOrchestratorRequest(req, makeUrl('/orchestrator/start'), API_URL);
    expect(res?.status).toBe(409);
  });

  it('valid repo → 200 ok: true', async () => {
    const loop = makeFakeLoop('stopped');
    _setDevLoop(loop);
    const req = makeRequest('POST', '/orchestrator/start', { repo: '/my/repo' });
    const res = await handleOrchestratorRequest(req, makeUrl('/orchestrator/start'), API_URL);
    expect(res?.status).toBe(200);
    const body = await res!.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(loop.spawn).toHaveBeenCalledWith('/my/repo', { slotCount: undefined });
  });

  it('slotCount forwarded to spawn', async () => {
    const loop = makeFakeLoop('stopped');
    _setDevLoop(loop);
    const req = makeRequest('POST', '/orchestrator/start', { repo: '/app', slotCount: 4 });
    await handleOrchestratorRequest(req, makeUrl('/orchestrator/start'), API_URL);
    expect(loop.spawn).toHaveBeenCalledWith('/app', { slotCount: 4 });
  });
});

// ── POST /orchestrator/stop ───────────────────────────────────────────────────

describe('POST /orchestrator/stop', () => {
  it('calls loop.stop(), returns { ok: true }', async () => {
    const loop = makeFakeLoop('running');
    _setDevLoop(loop);

    const req = makeRequest('POST', '/orchestrator/stop');
    const res = await handleOrchestratorRequest(req, makeUrl('/orchestrator/stop'), API_URL);
    expect(res?.status).toBe(200);
    const body = await res!.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(loop.stop).toHaveBeenCalledOnce();
  });

  it('idempotent — can call twice without error', async () => {
    const loop = makeFakeLoop('stopped');
    _setDevLoop(loop);

    for (let i = 0; i < 2; i++) {
      const req = makeRequest('POST', '/orchestrator/stop');
      await handleOrchestratorRequest(req, makeUrl('/orchestrator/stop'), API_URL);
    }
    expect(loop.stop).toHaveBeenCalledTimes(2);
  });
});

// ── GET /orchestrator/logs ────────────────────────────────────────────────────

describe('GET /orchestrator/logs', () => {
  it('returns text/event-stream response', async () => {
    _setDevLoop(makeFakeLoop());

    const req = makeRequest('GET', '/orchestrator/logs');
    const res = await handleOrchestratorRequest(req, makeUrl('/orchestrator/logs'), API_URL);
    expect(res?.headers.get('Content-Type')).toContain('text/event-stream');
  });

  it('emits buffered ring logs immediately on connect', async () => {
    const loop = makeFakeLoop();
    loop.logs = vi.fn(() => ['line1', 'line2']);
    _setDevLoop(loop);

    const req = makeRequest('GET', '/orchestrator/logs');
    const res = await handleOrchestratorRequest(req, makeUrl('/orchestrator/logs'), API_URL);

    // The SSE stream never closes (live tail). Read only the buffered chunk
    // by consuming the body with a race against a short timeout, then cancel.
    const body = res!.body!;
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let text = '';

    const deadline = new Promise<void>((r) => setTimeout(r, 50));
    const reading = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    })();

    await Promise.race([reading, deadline]);
    reader.cancel().catch(() => {});

    expect(text).toContain('data: line1');
    expect(text).toContain('data: line2');
  });
});
