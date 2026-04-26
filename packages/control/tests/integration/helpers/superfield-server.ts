/**
 * Integration test fixture: starts the superfield API server in-process on
 * a random port, with a claude stub injected into PATH so agent turns return
 * a predictable canned response without invoking the real claude binary.
 *
 * Usage:
 *   const fixture = await startSuperfieldFixture();
 *   process.env.SUPERFIELD_API_URL = fixture.apiUrl;
 *   // … run tests …
 *   fixture.stop();
 */

import { delimiter } from 'node:path';
import { ApiState } from '@superfield/core/api-state';
import { startApiServer } from '@superfield/core/api-server';

const FIXTURES_DIR = new URL('../../fixtures', import.meta.url).pathname;

export interface SuperfieldFixture {
  apiUrl: string;
  stop: () => Promise<void>;
}

export async function startSuperfieldFixture(): Promise<SuperfieldFixture> {
  // Inject the claude stub into PATH so Bun.spawn('claude', ...) in the API
  // server resolves to our stub script.
  const origPath = process.env.PATH ?? '';
  process.env.PATH = `${FIXTURES_DIR}${delimiter}${origPath}`;
  process.env.CLAUDE_E2E_LOG_PATH = process.env.CLAUDE_E2E_LOG_PATH ?? '/tmp/claude-studio-fixture.log';

  const state = new ApiState();
  const logger = {
    emit: (_level: string, _msg: string) => {
      // Silent in tests.
    },
  };

  // Use port 0 so the OS assigns a free port.
  const server = startApiServer({ port: 0, state, logger });

  await new Promise<void>((resolve) => {
    server.once('listening', resolve);
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const apiUrl = `http://127.0.0.1:${port}`;

  const stop = (): Promise<void> => {
    process.env.PATH = origPath;
    return new Promise((resolve) => server.close(() => resolve()));
  };

  return { apiUrl, stop };
}
