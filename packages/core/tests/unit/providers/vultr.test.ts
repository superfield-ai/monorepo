/**
 * Vultr provider unit tests.
 *
 * MSW v2 intercepts `https://api.vultr.com`. No vi.fn / vi.mock / vi.spyOn
 * / vi.stubGlobal anywhere — interception is the only seam.
 *
 * Fixtures live under packages/core/tests/fixtures/vultr/.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { provision, destroy } from "../../../providers/vultr/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "../../fixtures/vultr");

function fixture<T = unknown>(name: string): T {
  const raw = fs.readFileSync(path.join(FIXTURES, name), "utf8");
  return JSON.parse(raw) as T;
}

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const DERIVED_DEPLOY_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPYEK/XIcf5LKf+WMtLKls0GQmoaTwKYMcoeUAFmR9wO";

interface RecordedRequest {
  method: string;
  path: string;
  body?: unknown;
}

function makeServer(opts: {
  initialInstances: unknown;
  initialDatabases: unknown;
  instanceAfterCreate: unknown;
  databaseAfterCreate: unknown;
  managedDb: boolean;
  /** Throw on the password-reset PUT to exercise the create-fallback. */
  passwordResetReturns404?: boolean;
}): { server: ReturnType<typeof setupServer>; recorded: RecordedRequest[] } {
  const recorded: RecordedRequest[] = [];

  // Mutable refs so subsequent GETs reflect prior POSTs.
  let instancesList: unknown = opts.initialInstances;
  let databasesList: unknown = opts.initialDatabases;
  const instanceLookup = opts.instanceAfterCreate;
  const databaseLookup = opts.databaseAfterCreate;

  const handlers = [
    http.get("https://api.vultr.com/v2/ssh-keys", async () => {
      recorded.push({ method: "GET", path: "/v2/ssh-keys" });
      return HttpResponse.json(fixture("ssh-keys-empty.json"));
    }),
    http.post("https://api.vultr.com/v2/ssh-keys", async ({ request }) => {
      const body = (await request.json()) as { name: string; ssh_key: string };
      recorded.push({ method: "POST", path: "/v2/ssh-keys", body });
      // Reply with a stable id keyed on the requested name so the test can
      // assert which key id was attached to the instance.
      const id = body.name.endsWith("-ephemeral")
        ? "ssh-ephemeral-id"
        : "ssh-deploy-id";
      return HttpResponse.json({
        ssh_key: {
          id,
          name: body.name,
          ssh_key: body.ssh_key,
          date_created: "2026-04-18T00:00:00+00:00",
        },
      });
    }),

    http.get("https://api.vultr.com/v2/instances", async ({ request }) => {
      const url = new URL(request.url);
      recorded.push({
        method: "GET",
        path: `/v2/instances?tag=${url.searchParams.get("tag") ?? ""}`,
      });
      return HttpResponse.json(instancesList as Record<string, unknown>);
    }),
    http.post("https://api.vultr.com/v2/instances", async ({ request }) => {
      const body = await request.json();
      recorded.push({ method: "POST", path: "/v2/instances", body });
      // After create, the next GET-by-tag should find this instance.
      instancesList = fixture("instances-existing.json");
      return HttpResponse.json(
        opts.instanceAfterCreate as Record<string, unknown>,
      );
    }),
    http.get("https://api.vultr.com/v2/instances/:id", async ({ params }) => {
      recorded.push({ method: "GET", path: `/v2/instances/${params.id}` });
      return HttpResponse.json(instanceLookup as Record<string, unknown>);
    }),
    http.delete(
      "https://api.vultr.com/v2/instances/:id",
      async ({ params }) => {
        recorded.push({
          method: "DELETE",
          path: `/v2/instances/${params.id}`,
        });
        return new HttpResponse(null, { status: 204 });
      },
    ),

    http.get("https://api.vultr.com/v2/databases", async ({ request }) => {
      const url = new URL(request.url);
      recorded.push({
        method: "GET",
        path: `/v2/databases?tag=${url.searchParams.get("tag") ?? ""}`,
      });
      return HttpResponse.json(databasesList as Record<string, unknown>);
    }),
    http.post("https://api.vultr.com/v2/databases", async ({ request }) => {
      const body = await request.json();
      recorded.push({ method: "POST", path: "/v2/databases", body });
      databasesList = {
        databases: [
          (opts.databaseAfterCreate as { database: unknown }).database,
        ],
        meta: { total: 1, links: { next: "", prev: "" } },
      };
      return HttpResponse.json(
        opts.databaseAfterCreate as Record<string, unknown>,
      );
    }),
    http.get("https://api.vultr.com/v2/databases/:id", async ({ params }) => {
      recorded.push({ method: "GET", path: `/v2/databases/${params.id}` });
      return HttpResponse.json(databaseLookup as Record<string, unknown>);
    }),
    http.put(
      "https://api.vultr.com/v2/databases/:id/users/:user",
      async ({ request, params }) => {
        const body = await request.json();
        recorded.push({
          method: "PUT",
          path: `/v2/databases/${params.id}/users/${params.user}`,
          body,
        });
        if (opts.passwordResetReturns404) {
          return HttpResponse.json(
            { error: "user not found" },
            { status: 404 },
          );
        }
        return HttpResponse.json({
          user: {
            username: params.user,
            password: (body as { password: string }).password,
          },
        });
      },
    ),
    http.post(
      "https://api.vultr.com/v2/databases/:id/users",
      async ({ request, params }) => {
        const body = await request.json();
        recorded.push({
          method: "POST",
          path: `/v2/databases/${params.id}/users`,
          body,
        });
        return HttpResponse.json({
          user: {
            username: (body as { username: string }).username,
            password: (body as { password: string }).password,
          },
        });
      },
    ),
    http.post(
      "https://api.vultr.com/v2/databases/:id/databases",
      async ({ request, params }) => {
        const body = await request.json();
        recorded.push({
          method: "POST",
          path: `/v2/databases/${params.id}/databases`,
          body,
        });
        return HttpResponse.json({
          db: { name: (body as { name: string }).name },
        });
      },
    ),
    http.post(
      "https://api.vultr.com/v2/databases/:id/access-control",
      async ({ request, params }) => {
        const body = await request.json();
        recorded.push({
          method: "POST",
          path: `/v2/databases/${params.id}/access-control`,
          body,
        });
        return HttpResponse.json({ acl: (body as { acl: unknown }).acl });
      },
    ),
    http.delete(
      "https://api.vultr.com/v2/databases/:id",
      async ({ params }) => {
        recorded.push({
          method: "DELETE",
          path: `/v2/databases/${params.id}`,
        });
        return new HttpResponse(null, { status: 204 });
      },
    ),
    http.delete("https://api.vultr.com/v2/ssh-keys/:id", async ({ params }) => {
      recorded.push({ method: "DELETE", path: `/v2/ssh-keys/${params.id}` });
      return new HttpResponse(null, { status: 204 });
    }),
  ];

  const server = setupServer(...handlers);
  return { server, recorded };
}

const noSleep = async (): Promise<void> => {};

describe("vultr.provision", () => {
  let server: ReturnType<typeof setupServer> | undefined;
  let savedKey: string | undefined;

  beforeAll(() => {
    savedKey = process.env.VULTR_API_KEY;
  });
  afterAll(() => {
    if (savedKey === undefined) delete process.env.VULTR_API_KEY;
    else process.env.VULTR_API_KEY = savedKey;
  });

  beforeEach(() => {
    process.env.VULTR_API_KEY = "test-api-key";
  });

  afterEach(() => {
    if (server) {
      server.close();
      server = undefined;
    }
  });

  it("first run creates ssh keys, then instance, then waits for active in correct order", async () => {
    const { server: s, recorded } = makeServer({
      initialInstances: fixture("instances-empty.json"),
      initialDatabases: fixture("databases-empty.json"),
      instanceAfterCreate: fixture("instance-active.json"),
      databaseAfterCreate: fixture("database-running.json"),
      managedDb: false,
    });
    server = s;
    server.listen({ onUnhandledRequest: "error" });

    const result = await provision({
      env: "test",
      managedDb: false,
      derivedDeployKeyPublicOpenSsh: DERIVED_DEPLOY_KEY,
      sleep: noSleep,
      maxPollAttempts: 3,
      pollDelayMs: 0,
    });

    expect(result.host).toBe("203.0.113.42");
    expect(result.initialPrivateKeyPem).toMatch(/BEGIN PRIVATE KEY/);
    expect(result.databaseUrl).toBeUndefined();

    // Order assertions: ssh keys checked & created first, then instance
    // search-by-tag, then create, then GET-by-id until active.
    const paths = recorded.map((r) => `${r.method} ${r.path}`);
    expect(paths[0]).toBe("GET /v2/ssh-keys");
    expect(paths[1]).toBe("POST /v2/ssh-keys");
    expect(paths[2]).toBe("GET /v2/ssh-keys");
    expect(paths[3]).toBe("POST /v2/ssh-keys");
    expect(paths[4]).toBe("GET /v2/instances?tag=superfield-env=test");
    expect(paths[5]).toBe("POST /v2/instances");
    expect(paths[6]).toBe("GET /v2/instances/inst-abc-123");

    // The instance create body wires both ssh keys and the env tag.
    const createInstance = recorded.find(
      (r) => r.method === "POST" && r.path === "/v2/instances",
    );
    expect(createInstance).toBeDefined();
    const body = createInstance!.body as Record<string, unknown>;
    expect(body.region).toBe("ewr");
    expect(body.plan).toBe("vc2-1c-2gb");
    expect(body.os_id).toBe(2284);
    expect(body.tag).toBe("superfield-env=test");
    expect(body.sshkey_id).toEqual(["ssh-ephemeral-id", "ssh-deploy-id"]);
  });

  it("second run reuses the instance by tag without POSTing to /v2/instances", async () => {
    const { server: s, recorded } = makeServer({
      initialInstances: fixture("instances-existing.json"),
      initialDatabases: fixture("databases-empty.json"),
      instanceAfterCreate: fixture("instance-active.json"),
      databaseAfterCreate: fixture("database-running.json"),
      managedDb: false,
    });
    server = s;
    server.listen({ onUnhandledRequest: "error" });

    const result = await provision({
      env: "test",
      managedDb: false,
      derivedDeployKeyPublicOpenSsh: DERIVED_DEPLOY_KEY,
      sleep: noSleep,
      maxPollAttempts: 3,
      pollDelayMs: 0,
    });

    expect(result.host).toBe("203.0.113.42");
    const instancePosts = recorded.filter(
      (r) => r.method === "POST" && r.path === "/v2/instances",
    );
    expect(instancePosts).toHaveLength(0);
  });

  it("managedDb=true returns a postgresql URL with the derived password and skips no DB endpoints", async () => {
    const { server: s, recorded } = makeServer({
      initialInstances: fixture("instances-empty.json"),
      initialDatabases: fixture("databases-empty.json"),
      instanceAfterCreate: fixture("instance-active.json"),
      databaseAfterCreate: fixture("database-running.json"),
      managedDb: true,
    });
    server = s;
    server.listen({ onUnhandledRequest: "error" });

    const mnemonic = Buffer.from(TEST_MNEMONIC, "utf8");

    const result = await provision({
      env: "test",
      managedDb: true,
      derivedDeployKeyPublicOpenSsh: DERIVED_DEPLOY_KEY,
      mnemonic,
      sleep: noSleep,
      maxPollAttempts: 3,
      pollDelayMs: 0,
    });

    // Known answer for derivePassword(abandon×11 about, "test", "db-password", 32)
    // — we do not hard-code it here because the secrets module owns its
    // KAT vectors. We only assert the URL shape and that it is present.
    expect(result.databaseUrl).toMatch(
      /^postgresql:\/\/app:[0-9a-f]{64}@test-db\.vultrdb\.example:16751\/app\?sslmode=require$/,
    );

    const paths = recorded.map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain("POST /v2/databases");
    expect(paths).toContain("GET /v2/databases/db-xyz-789");
    expect(paths).toContain("PUT /v2/databases/db-xyz-789/users/app");
    expect(paths).toContain("POST /v2/databases/db-xyz-789/databases");
    expect(paths).toContain("POST /v2/databases/db-xyz-789/access-control");

    // Access-control body lists the instance IP /32.
    const acl = recorded.find(
      (r) => r.path === "/v2/databases/db-xyz-789/access-control",
    );
    expect(acl?.body).toEqual({ acl: [{ source: "203.0.113.42/32" }] });

    // Mnemonic should have been zeroed by derivePassword.
    expect(mnemonic.every((b) => b === 0)).toBe(true);
  });

  it("managedDb=false skips every database endpoint", async () => {
    const { server: s, recorded } = makeServer({
      initialInstances: fixture("instances-empty.json"),
      initialDatabases: fixture("databases-empty.json"),
      instanceAfterCreate: fixture("instance-active.json"),
      databaseAfterCreate: fixture("database-running.json"),
      managedDb: false,
    });
    server = s;
    server.listen({ onUnhandledRequest: "error" });

    await provision({
      env: "test",
      managedDb: false,
      derivedDeployKeyPublicOpenSsh: DERIVED_DEPLOY_KEY,
      sleep: noSleep,
      maxPollAttempts: 3,
      pollDelayMs: 0,
    });

    const dbCalls = recorded.filter((r) => r.path.includes("/v2/databases"));
    expect(dbCalls).toHaveLength(0);
  });

  it("falls back to creating the user when password reset returns 404", async () => {
    const { server: s, recorded } = makeServer({
      initialInstances: fixture("instances-empty.json"),
      initialDatabases: fixture("databases-empty.json"),
      instanceAfterCreate: fixture("instance-active.json"),
      databaseAfterCreate: fixture("database-running.json"),
      managedDb: true,
      passwordResetReturns404: true,
    });
    server = s;
    server.listen({ onUnhandledRequest: "error" });

    const mnemonic = Buffer.from(TEST_MNEMONIC, "utf8");

    const result = await provision({
      env: "test",
      managedDb: true,
      derivedDeployKeyPublicOpenSsh: DERIVED_DEPLOY_KEY,
      mnemonic,
      sleep: noSleep,
      maxPollAttempts: 3,
      pollDelayMs: 0,
    });

    expect(result.databaseUrl).toMatch(/^postgresql:\/\/app:/);
    const paths = recorded.map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain("PUT /v2/databases/db-xyz-789/users/app");
    expect(paths).toContain("POST /v2/databases/db-xyz-789/users");
  });

  it("errors clearly when VULTR_API_KEY is missing", async () => {
    delete process.env.VULTR_API_KEY;
    await expect(
      provision({
        env: "test",
        managedDb: false,
        derivedDeployKeyPublicOpenSsh: DERIVED_DEPLOY_KEY,
        sleep: noSleep,
      }),
    ).rejects.toThrow(/VULTR_API_KEY is not set/);
  });
});

describe("vultr.destroy", () => {
  let server: ReturnType<typeof setupServer> | undefined;
  let savedKey: string | undefined;

  beforeAll(() => {
    savedKey = process.env.VULTR_API_KEY;
  });
  afterAll(() => {
    if (savedKey === undefined) delete process.env.VULTR_API_KEY;
    else process.env.VULTR_API_KEY = savedKey;
  });

  beforeEach(() => {
    process.env.VULTR_API_KEY = "test-api-key";
  });

  afterEach(() => {
    if (server) {
      server.close();
      server = undefined;
    }
  });

  it("deletes instance + database + tagged ssh keys when present", async () => {
    const { server: s, recorded } = makeServer({
      initialInstances: fixture("instances-existing.json"),
      initialDatabases: {
        databases: [
          fixture<{ database: unknown }>("database-running.json").database,
        ],
        meta: { total: 1, links: { next: "", prev: "" } },
      },
      instanceAfterCreate: fixture("instance-active.json"),
      databaseAfterCreate: fixture("database-running.json"),
      managedDb: true,
    });

    // Replace ssh-keys GET to return two keys whose names we control.
    s.use(
      http.get("https://api.vultr.com/v2/ssh-keys", async () => {
        return HttpResponse.json({
          ssh_keys: [
            {
              id: "ssh-ephemeral-id",
              name: "superfield-test-ephemeral",
              ssh_key: "ssh-ed25519 AAAA",
              date_created: "x",
            },
            {
              id: "ssh-deploy-id",
              name: "superfield-test-deploy",
              ssh_key: "ssh-ed25519 BBBB",
              date_created: "x",
            },
            {
              id: "ssh-other-id",
              name: "unrelated-key",
              ssh_key: "ssh-ed25519 CCCC",
              date_created: "x",
            },
          ],
          meta: { total: 3, links: { next: "", prev: "" } },
        });
      }),
    );

    server = s;
    server.listen({ onUnhandledRequest: "error" });

    await destroy({ env: "test" });

    const paths = recorded.map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain("DELETE /v2/instances/inst-abc-123");
    expect(paths).toContain("DELETE /v2/databases/db-xyz-789");
    expect(paths).toContain("DELETE /v2/ssh-keys/ssh-ephemeral-id");
    expect(paths).toContain("DELETE /v2/ssh-keys/ssh-deploy-id");
    expect(paths).not.toContain("DELETE /v2/ssh-keys/ssh-other-id");
  });
});

// Smoke test gated behind the env var. Skipped in CI without credentials.
describe.skipIf(!process.env.VULTR_API_KEY_SMOKE)(
  "vultr.provision (smoke)",
  () => {
    it("provisions and destroys a real env (smoke)", async () => {
      process.env.VULTR_API_KEY = process.env.VULTR_API_KEY_SMOKE;
      const env = `smoke-${Date.now()}`;
      const result = await provision({
        env,
        managedDb: false,
        derivedDeployKeyPublicOpenSsh: DERIVED_DEPLOY_KEY,
      });
      expect(result.host).toMatch(/\d+\.\d+\.\d+\.\d+/);
      await destroy({ env });
    }, 600_000);
  },
);
