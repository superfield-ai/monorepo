import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import { destroy } from "../../../commands/destroy.ts";
import type { GitHubHttpDeps } from "../../../github/types.ts";

const BASE = "https://api.github.com";
const REPO = "test-org/test-repo";

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeDeps(): GitHubHttpDeps {
  return {
    fetch: globalThis.fetch,
    getToken: async () => "test-token",
  };
}

/** Build a fake GitHub server that records secret/variable deletions. */
function installFakeGitHub(state: {
  deletedSecrets: string[];
  deletedVariables: string[];
}): void {
  server.use(
    // DELETE secret
    http.delete(`${BASE}/repos/${REPO}/actions/secrets/:name`, ({ params }) => {
      state.deletedSecrets.push(params.name as string);
      return new HttpResponse(null, { status: 204 });
    }),
    // DELETE variable
    http.delete(
      `${BASE}/repos/${REPO}/actions/variables/:name`,
      ({ params }) => {
        state.deletedVariables.push(params.name as string);
        return new HttpResponse(null, { status: 204 });
      },
    ),
  );
}

// ---------------------------------------------------------------------------
// 1. Prod safety gate
// ---------------------------------------------------------------------------

describe("prod safety gate", () => {
  it("throws when env=prod and yesIReallyMeanIt is not set", async () => {
    await expect(
      destroy(
        { env: "prod", provider: "gcp", repo: REPO },
        {
          providerDestroy: async () => {},
          confirm: async () => true,
          log: () => {},
          githubDeps: makeDeps(),
        },
      ),
    ).rejects.toThrow(/--yes-i-really-mean-it/);
  });

  it("does NOT throw when env=prod and yesIReallyMeanIt=true", async () => {
    const state = {
      deletedSecrets: [] as string[],
      deletedVariables: [] as string[],
    };
    installFakeGitHub(state);

    await expect(
      destroy(
        {
          env: "prod",
          provider: "gcp",
          repo: REPO,
          yes: true,
          yesIReallyMeanIt: true,
        },
        {
          providerDestroy: async () => {},
          log: () => {},
          githubDeps: makeDeps(),
        },
      ),
    ).resolves.toBeUndefined();
  });

  it("does NOT throw when env is not prod even without yesIReallyMeanIt", async () => {
    const state = {
      deletedSecrets: [] as string[],
      deletedVariables: [] as string[],
    };
    installFakeGitHub(state);

    await expect(
      destroy(
        { env: "staging", provider: "gcp", repo: REPO, yes: true },
        {
          providerDestroy: async () => {},
          log: () => {},
          githubDeps: makeDeps(),
        },
      ),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Secrets deletion
// ---------------------------------------------------------------------------

describe("secrets deletion", () => {
  it("deletes all expected secrets and fingerprint variables for the env", async () => {
    const state = {
      deletedSecrets: [] as string[],
      deletedVariables: [] as string[],
    };
    installFakeGitHub(state);

    await destroy(
      { env: "staging", provider: "digitalocean", repo: REPO, yes: true },
      {
        providerDestroy: async () => {},
        log: () => {},
        githubDeps: makeDeps(),
      },
    );

    const envUpper = "STAGING";
    const expectedSecrets = [
      `DEPLOY_HOST_${envUpper}`,
      `DATABASE_URL_${envUpper}`,
      `WEBHOOK_SECRET_${envUpper}`,
      `COOKIE_SECRET_${envUpper}`,
      `DEPLOY_KEY_${envUpper}`,
    ];
    const expectedVariables = expectedSecrets.map((s) => `${s}_FP`);

    for (const name of expectedSecrets) {
      expect(state.deletedSecrets).toContain(name);
    }
    for (const name of expectedVariables) {
      expect(state.deletedVariables).toContain(name);
    }

    // Total: 5 secrets + 5 fingerprint variables
    expect(state.deletedSecrets).toHaveLength(5);
    expect(state.deletedVariables).toHaveLength(5);
  });

  it("is idempotent: 404 responses for secrets/variables are silently ignored", async () => {
    server.use(
      http.delete(`${BASE}/repos/${REPO}/actions/secrets/:name`, () =>
        HttpResponse.json({ message: "Not Found" }, { status: 404 }),
      ),
      http.delete(`${BASE}/repos/${REPO}/actions/variables/:name`, () =>
        HttpResponse.json({ message: "Not Found" }, { status: 404 }),
      ),
    );

    await expect(
      destroy(
        { env: "staging", provider: "aws", repo: REPO, yes: true },
        {
          providerDestroy: async () => {},
          log: () => {},
          githubDeps: makeDeps(),
        },
      ),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Deploy key NOT deleted
// ---------------------------------------------------------------------------

describe("deploy key handling", () => {
  it("prints instructions for manual removal but does NOT call any delete deploy key API", async () => {
    const state = {
      deletedSecrets: [] as string[],
      deletedVariables: [] as string[],
    };
    // Track any deploy-key DELETE calls
    const deployKeyDeleteCalls: string[] = [];

    server.use(
      http.delete(
        `${BASE}/repos/${REPO}/actions/secrets/:name`,
        ({ params }) => {
          state.deletedSecrets.push(params.name as string);
          return new HttpResponse(null, { status: 204 });
        },
      ),
      http.delete(
        `${BASE}/repos/${REPO}/actions/variables/:name`,
        ({ params }) => {
          state.deletedVariables.push(params.name as string);
          return new HttpResponse(null, { status: 204 });
        },
      ),
      http.delete(`${BASE}/repos/${REPO}/keys/:id`, ({ params }) => {
        deployKeyDeleteCalls.push(String(params.id));
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const logLines: string[] = [];
    await destroy(
      { env: "demo", provider: "vultr", repo: REPO, yes: true },
      {
        providerDestroy: async () => {},
        log: (msg) => logLines.push(msg),
        githubDeps: makeDeps(),
      },
    );

    // No deploy key deletion API was called.
    expect(deployKeyDeleteCalls).toHaveLength(0);

    // But instructions were printed.
    const allLogs = logLines.join("\n");
    expect(allLogs).toMatch(/settings\/keys/);
    expect(allLogs).toMatch(/superfield-deploy-demo/);
  });
});

// ---------------------------------------------------------------------------
// 4. Provider destroy is called
// ---------------------------------------------------------------------------

describe("provider destroy", () => {
  it("calls the injected provider destroy with the correct env", async () => {
    const state = {
      deletedSecrets: [] as string[],
      deletedVariables: [] as string[],
    };
    installFakeGitHub(state);

    const calls: Array<{ env: string }> = [];

    await destroy(
      { env: "dev", provider: "aws", repo: REPO, yes: true },
      {
        providerDestroy: async (opts) => {
          calls.push({ env: opts.env });
        },
        log: () => {},
        githubDeps: makeDeps(),
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.env).toBe("dev");
  });
});

// ---------------------------------------------------------------------------
// 5. Interactive confirmation
// ---------------------------------------------------------------------------

describe("interactive confirmation", () => {
  it("cancels when user does not confirm", async () => {
    const providerDestroy = vi.fn();

    const logLines: string[] = [];
    await destroy(
      { env: "staging", provider: "gcp", repo: REPO },
      {
        confirm: async () => false,
        providerDestroy,
        log: (msg) => logLines.push(msg),
        githubDeps: makeDeps(),
      },
    );

    expect(providerDestroy).not.toHaveBeenCalled();
    expect(logLines.join("\n")).toMatch(/cancel/i);
  });

  it("proceeds when user confirms", async () => {
    const state = {
      deletedSecrets: [] as string[],
      deletedVariables: [] as string[],
    };
    installFakeGitHub(state);

    const providerDestroy = vi.fn().mockResolvedValue(undefined);

    await destroy(
      { env: "staging", provider: "gcp", repo: REPO },
      {
        confirm: async () => true,
        providerDestroy,
        log: () => {},
        githubDeps: makeDeps(),
      },
    );

    expect(providerDestroy).toHaveBeenCalledOnce();
  });
});
