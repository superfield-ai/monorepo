/**
 * Unit tests for studio/apps/server/src/config.ts
 *
 * Issue #11 test plan items covered:
 *   - config.test.ts asserts defaults for all 8 StudioConfig fields when env vars are unset
 *   - config.test.ts asserts custom values when env vars are set
 */

import { describe, it, expect, afterEach } from 'vitest';
import { loadConfig, vlog } from '../../src/config';

// ── helpers ───────────────────────────────────────────────────────────────────

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const original: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    original[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

// ── loadConfig — defaults ─────────────────────────────────────────────────────

describe('loadConfig — defaults when no env vars are set', () => {
  const allVars = {
    STUDIO_PORT: undefined,
    STUDIO_LOG_DIR: undefined,
    STUDIO_CLUSTER_CONTEXT: undefined,
    STUDIO_OPEN_BROWSER: undefined,
    STUDIO_WEB_SERVICE_HOST: undefined,
    STUDIO_WEB_SERVICE_PORT: undefined,
    STUDIO_API_SERVICE_HOST: undefined,
    STUDIO_API_SERVICE_PORT: undefined,
    STUDIO_ASSETS_DIR: undefined,
    STUDIO_VERBOSE: undefined,
    CALYPSO_REPO_ROOT: undefined,
  };

  it('defaults port to 7000', () => {
    withEnv(allVars, () => {
      const config = loadConfig();
      expect(config.port).toBe(7000);
    });
  });

  it('defaults logDir to ../studio-logs', () => {
    withEnv(allVars, () => {
      const config = loadConfig();
      expect(config.logDir).toBe('../studio-logs');
    });
  });

  it('defaults clusterContext to default', () => {
    withEnv(allVars, () => {
      const config = loadConfig();
      expect(config.clusterContext).toBe('default');
    });
  });

  it('defaults openBrowser to false', () => {
    withEnv(allVars, () => {
      const config = loadConfig();
      expect(config.openBrowser).toBe(false);
    });
  });

  it('defaults webServiceUrl to http://127.0.0.1:80', () => {
    withEnv(allVars, () => {
      const config = loadConfig();
      expect(config.webServiceUrl).toBe('http://127.0.0.1:80');
    });
  });

  it('defaults apiServiceUrl to http://127.0.0.1:31415', () => {
    withEnv(allVars, () => {
      const config = loadConfig();
      expect(config.apiServiceUrl).toBe('http://127.0.0.1:31415');
    });
  });

  it('defaults assetsDir to undefined', () => {
    withEnv(allVars, () => {
      const config = loadConfig();
      expect(config.assetsDir).toBeUndefined();
    });
  });

  it('defaults verbose to false', () => {
    withEnv(allVars, () => {
      const config = loadConfig();
      expect(config.verbose).toBe(false);
    });
  });
});

// ── loadConfig — custom values ────────────────────────────────────────────────

describe('loadConfig — custom values via env vars', () => {
  it('reads STUDIO_PORT as a number', () => {
    withEnv({ STUDIO_PORT: '9999' }, () => {
      const config = loadConfig();
      expect(config.port).toBe(9999);
    });
  });

  it('reads STUDIO_LOG_DIR', () => {
    withEnv({ STUDIO_LOG_DIR: '/var/log/studio' }, () => {
      const config = loadConfig();
      expect(config.logDir).toBe('/var/log/studio');
    });
  });

  it('reads STUDIO_CLUSTER_CONTEXT', () => {
    withEnv({ STUDIO_CLUSTER_CONTEXT: 'prod' }, () => {
      const config = loadConfig();
      expect(config.clusterContext).toBe('prod');
    });
  });

  it('sets openBrowser to true when STUDIO_OPEN_BROWSER=1', () => {
    withEnv({ STUDIO_OPEN_BROWSER: '1' }, () => {
      const config = loadConfig();
      expect(config.openBrowser).toBe(true);
    });
  });

  it('leaves openBrowser false when STUDIO_OPEN_BROWSER is not 1', () => {
    withEnv({ STUDIO_OPEN_BROWSER: '0' }, () => {
      const config = loadConfig();
      expect(config.openBrowser).toBe(false);
    });
  });

  it('constructs webServiceUrl from STUDIO_WEB_SERVICE_HOST and STUDIO_WEB_SERVICE_PORT', () => {
    withEnv({ STUDIO_WEB_SERVICE_HOST: '10.0.0.1', STUDIO_WEB_SERVICE_PORT: '3000' }, () => {
      const config = loadConfig();
      expect(config.webServiceUrl).toBe('http://10.0.0.1:3000');
    });
  });

  it('constructs apiServiceUrl from STUDIO_API_SERVICE_HOST and STUDIO_API_SERVICE_PORT', () => {
    withEnv({ STUDIO_API_SERVICE_HOST: '10.0.0.2', STUDIO_API_SERVICE_PORT: '4000' }, () => {
      const config = loadConfig();
      expect(config.apiServiceUrl).toBe('http://10.0.0.2:4000');
    });
  });

  it('reads STUDIO_ASSETS_DIR', () => {
    withEnv({ STUDIO_ASSETS_DIR: '/srv/ui/dist' }, () => {
      const config = loadConfig();
      expect(config.assetsDir).toBe('/srv/ui/dist');
    });
  });

  it('sets verbose to true when STUDIO_VERBOSE=1', () => {
    withEnv({ STUDIO_VERBOSE: '1' }, () => {
      const config = loadConfig();
      expect(config.verbose).toBe(true);
    });
  });

  it('leaves verbose false when STUDIO_VERBOSE is not 1', () => {
    withEnv({ STUDIO_VERBOSE: 'true' }, () => {
      const config = loadConfig();
      expect(config.verbose).toBe(false);
    });
  });
});

// ── vlog ─────────────────────────────────────────────────────────────────────

describe('vlog', () => {
  afterEach(() => {
    // No spy needed — we just verify it does not throw.
  });

  it('does not call console.log when verbose is false', () => {
    const calls: unknown[][] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => calls.push(args);
    try {
      vlog({ verbose: false }, 'should not appear');
      expect(calls).toHaveLength(0);
    } finally {
      console.log = originalLog;
    }
  });

  it('calls console.log when verbose is true', () => {
    const calls: unknown[][] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => calls.push(args);
    try {
      vlog({ verbose: true }, 'hello', 'world');
      expect(calls).toHaveLength(1);
      const [prefix, ...rest] = calls[0];
      expect(String(prefix)).toMatch(/^\[studio:verbose/);
      expect(rest).toEqual(['hello', 'world']);
    } finally {
      console.log = originalLog;
    }
  });
});
