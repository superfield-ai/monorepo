/**
 * Unit tests for `packages/core/providers/digitalocean` (issue #150).
 *
 * No mocks. MSW v2 intercepts all `https://api.digitalocean.com` calls and
 * a small in-memory state object models the DO resource lifecycle so we can
 * assert call ordering, idempotency by tag, and managed-DB plumbing without
 * touching the real network.
 */

import { afterAll, afterEach, beforeAll, describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import {
  provision,
  destroy,
  generateEphemeralSshKey,
  __internal,
} from "../../providers/digitalocean/index.ts";
import { derivePassword } from "../../secrets/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(
  __dirname,
  "../fixtures/digitalocean",
);

function loadFixture(name: string): Record<string, unknown> {
  const raw = fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

// 12-word valid BIP-39 mnemonic (one of the standard test vectors).
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const DERIVED_DEPLOY_PUBLIC =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAm5sIeRkpTrcZRn9C5Q3xZRFNjjwOe6oHMzS6jL3sUm derived";

interface State {
  calls: { method: string; url: string }[];
  tagExists: boolean;
  keys: {
    id: number;
    name: string;
    public_key: string;
    fingerprint: string;
  }[];
  nextKeyId: number;
  droplet: ReturnType<typeof loadFixture> | null;
  dropletStatus: "new" | "active";
  database: ReturnType<typeof loadFixture> | null;
  databaseStatus: "creating" | "online";
  appDbCreated: boolean;
  appUserCreated: boolean;
  passwordResetTo: string | null;
  firewallRules: unknown[] | null;
  lastDropletCreateBody: Record<string, unknown> | null;
  lastUploadedKeys: { name: string; public_key: string }[];
}

let state: State;

function newState(): State {
  return {
    calls: [],
    tagExists: false,
    keys: [],
    nextKeyId: 1,
    droplet: null,
    dropletStatus: "new",
    database: null,
    databaseStatus: "creating",
    appDbCreated: false,
    appUserCreated: false,
    passwordResetTo: null,
    firewallRules: null,
    lastDropletCreateBody: null,
    lastUploadedKeys: [],
  };
}

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => server.close());

function installHandlers(): void {
  server.use(
    // Tags: GET / POST
    http.get("https://api.digitalocean.com/v2/tags/:tag", ({ request }) => {
      state.calls.push({ method: "GET", url: new URL(request.url).pathname });
      if (state.tagExists) {
        return HttpResponse.json({ tag: { name: "superfield-env=test" } });
      }
      return new HttpResponse(null, { status: 404 });
    }),
    http.post("https://api.digitalocean.com/v2/tags", async ({ request }) => {
      state.calls.push({ method: "POST", url: "/v2/tags" });
      state.tagExists = true;
      const body = (await request.json()) as { name: string };
      return HttpResponse.json({ tag: { name: body.name } }, { status: 201 });
    }),

    // SSH keys
    http.post(
      "https://api.digitalocean.com/v2/account/keys",
      async ({ request }) => {
        state.calls.push({ method: "POST", url: "/v2/account/keys" });
        const body = (await request.json()) as {
          name: string;
          public_key: string;
        };
        const existing = state.keys.find(
          (k) =>
            k.public_key.split(/\s+/)[1] === body.public_key.split(/\s+/)[1],
        );
        if (existing) {
          return HttpResponse.json(
            { id: "unprocessable_entity", message: "SSH Key is already in use" },
            { status: 422 },
          );
        }
        state.lastUploadedKeys.push({
          name: body.name,
          public_key: body.public_key,
        });
        const id = state.nextKeyId++;
        const fingerprint = `fp:${id}:${body.public_key.split(/\s+/)[1]?.slice(0, 8) ?? ""}`;
        const key = {
          id,
          name: body.name,
          public_key: body.public_key,
          fingerprint,
        };
        state.keys.push(key);
        return HttpResponse.json({ ssh_key: key }, { status: 201 });
      },
    ),
    http.get("https://api.digitalocean.com/v2/account/keys", ({ request }) => {
      state.calls.push({ method: "GET", url: "/v2/account/keys" });
      void request;
      return HttpResponse.json({ ssh_keys: state.keys });
    }),
    http.delete(
      "https://api.digitalocean.com/v2/account/keys/:id",
      ({ params }) => {
        state.calls.push({
          method: "DELETE",
          url: `/v2/account/keys/${params.id}`,
        });
        const id = Number(params.id);
        state.keys = state.keys.filter((k) => k.id !== id);
        return new HttpResponse(null, { status: 204 });
      },
    ),

    // Droplets
    http.get("https://api.digitalocean.com/v2/droplets", ({ request }) => {
      const url = new URL(request.url);
      state.calls.push({
        method: "GET",
        url: `/v2/droplets?tag_name=${url.searchParams.get("tag_name") ?? ""}`,
      });
      if (state.droplet) {
        return HttpResponse.json({
          droplets: [
            (state.droplet as { droplet: unknown }).droplet,
          ],
        });
      }
      return HttpResponse.json({ droplets: [] });
    }),
    http.post(
      "https://api.digitalocean.com/v2/droplets",
      async ({ request }) => {
        state.calls.push({ method: "POST", url: "/v2/droplets" });
        const body = (await request.json()) as Record<string, unknown>;
        state.lastDropletCreateBody = body;
        // First GET after create returns "new", second returns "active"
        state.droplet = loadFixture("droplet-new") as Record<string, unknown>;
        state.dropletStatus = "new";
        return HttpResponse.json(state.droplet, { status: 202 });
      },
    ),
    http.get(
      "https://api.digitalocean.com/v2/droplets/:id",
      ({ params }) => {
        state.calls.push({
          method: "GET",
          url: `/v2/droplets/${params.id}`,
        });
        // Flip to active on first poll
        if (state.dropletStatus === "new") {
          state.dropletStatus = "active";
          state.droplet = loadFixture("droplet-active") as Record<
            string,
            unknown
          >;
        }
        return HttpResponse.json(state.droplet);
      },
    ),
    http.delete(
      "https://api.digitalocean.com/v2/droplets",
      ({ request }) => {
        const url = new URL(request.url);
        state.calls.push({
          method: "DELETE",
          url: `/v2/droplets?tag_name=${url.searchParams.get("tag_name") ?? ""}`,
        });
        state.droplet = null;
        return new HttpResponse(null, { status: 204 });
      },
    ),

    // Databases
    http.get("https://api.digitalocean.com/v2/databases", ({ request }) => {
      const url = new URL(request.url);
      state.calls.push({
        method: "GET",
        url: `/v2/databases?tag_name=${url.searchParams.get("tag_name") ?? ""}`,
      });
      if (state.database) {
        return HttpResponse.json({
          databases: [
            (state.database as { database: unknown }).database,
          ],
        });
      }
      return HttpResponse.json({ databases: [] });
    }),
    http.post(
      "https://api.digitalocean.com/v2/databases",
      async ({ request }) => {
        state.calls.push({ method: "POST", url: "/v2/databases" });
        await request.json();
        state.database = loadFixture("database-creating") as Record<
          string,
          unknown
        >;
        state.databaseStatus = "creating";
        return HttpResponse.json(state.database, { status: 201 });
      },
    ),
    http.get(
      "https://api.digitalocean.com/v2/databases/:id",
      ({ params }) => {
        state.calls.push({
          method: "GET",
          url: `/v2/databases/${params.id}`,
        });
        if (state.databaseStatus === "creating") {
          state.databaseStatus = "online";
          state.database = loadFixture("database-online") as Record<
            string,
            unknown
          >;
        }
        return HttpResponse.json(state.database);
      },
    ),
    http.post(
      "https://api.digitalocean.com/v2/databases/:id/dbs",
      async ({ request, params }) => {
        state.calls.push({
          method: "POST",
          url: `/v2/databases/${params.id}/dbs`,
        });
        await request.json();
        state.appDbCreated = true;
        return HttpResponse.json(
          { db: { name: "app" } },
          { status: 201 },
        );
      },
    ),
    http.post(
      "https://api.digitalocean.com/v2/databases/:id/users",
      async ({ request, params }) => {
        state.calls.push({
          method: "POST",
          url: `/v2/databases/${params.id}/users`,
        });
        await request.json();
        state.appUserCreated = true;
        return HttpResponse.json(
          { user: { name: "app", password: "auto-generated" } },
          { status: 201 },
        );
      },
    ),
    http.post(
      "https://api.digitalocean.com/v2/databases/:id/users/:user/reset_auth",
      async ({ request, params }) => {
        state.calls.push({
          method: "POST",
          url: `/v2/databases/${params.id}/users/${params.user}/reset_auth`,
        });
        const body = (await request.json()) as { new_password: string };
        state.passwordResetTo = body.new_password;
        return HttpResponse.json({ user: { name: params.user } });
      },
    ),
    http.put(
      "https://api.digitalocean.com/v2/databases/:id/firewall",
      async ({ request, params }) => {
        state.calls.push({
          method: "PUT",
          url: `/v2/databases/${params.id}/firewall`,
        });
        const body = (await request.json()) as { rules: unknown[] };
        state.firewallRules = body.rules;
        return HttpResponse.json({ rules: body.rules });
      },
    ),
    http.delete(
      "https://api.digitalocean.com/v2/databases/:id",
      ({ params }) => {
        state.calls.push({
          method: "DELETE",
          url: `/v2/databases/${params.id}`,
        });
        state.database = null;
        return new HttpResponse(null, { status: 204 });
      },
    ),
  );
}

const baseOpts = {
  env: "test",
  derivedDeployKeyPublicOpenSsh: DERIVED_DEPLOY_PUBLIC,
  token: "fake-token",
  pollIntervalMs: 1,
  pollMaxAttempts: 5,
};

describe("digitalocean.provision (first run)", () => {
  it("creates the tag, uploads keys, and creates a droplet in order", async () => {
    state = newState();
    installHandlers();

    const result = await provision({
      ...baseOpts,
      managedDb: false,
    });

    expect(result.host).toBe("203.0.113.42");
    expect(result.initialPrivateKeyPem).toMatch(/BEGIN PRIVATE KEY/);
    expect(result.databaseUrl).toBeUndefined();

    const ordered = state.calls.map((c) => `${c.method} ${c.url}`);
    // Expect (in order): tag check, tag create, two key uploads, droplet
    // list-by-tag, droplet create, droplet poll.
    expect(ordered[0]).toBe("GET /v2/tags/superfield-env%3Dtest");
    expect(ordered[1]).toBe("POST /v2/tags");
    expect(ordered[2]).toBe("POST /v2/account/keys");
    expect(ordered[3]).toBe("POST /v2/account/keys");
    expect(ordered[4]).toBe(
      "GET /v2/droplets?tag_name=superfield-env=test",
    );
    expect(ordered[5]).toBe("POST /v2/droplets");
    expect(ordered[6]).toBe("GET /v2/droplets/100001");

    // Droplet body referenced both ssh key fingerprints.
    const created = state.lastDropletCreateBody!;
    expect(created.size).toBe("s-1vcpu-2gb");
    expect(created.region).toBe("nyc1");
    expect(created.image).toBe("ubuntu-24-04-x64");
    expect(Array.isArray(created.ssh_keys)).toBe(true);
    expect((created.ssh_keys as string[]).length).toBe(2);
    // Both fingerprints come from our state, which assigned them.
    const expectedFps = state.keys.map((k) => k.fingerprint).sort();
    expect((created.ssh_keys as string[]).slice().sort()).toEqual(expectedFps);

    // Both ephemeral and derived deploy public keys were uploaded.
    expect(state.lastUploadedKeys.length).toBe(2);
    const uploadedNames = state.lastUploadedKeys.map((k) => k.name).sort();
    expect(uploadedNames[0]).toMatch(/superfield-test-deploy/);
    expect(uploadedNames[1]).toMatch(/superfield-test-ephemeral-/);
  });
});

describe("digitalocean.provision (idempotent re-run)", () => {
  it("reuses existing droplet by tag and does not create a duplicate", async () => {
    state = newState();
    installHandlers();
    // Pre-seed: tag exists, droplet exists active, derived key already uploaded.
    state.tagExists = true;
    state.droplet = loadFixture("droplet-active");
    state.dropletStatus = "active";
    state.keys.push({
      id: 99,
      name: "superfield-test-deploy",
      public_key: DERIVED_DEPLOY_PUBLIC,
      fingerprint: "fp:99:existing",
    });
    state.nextKeyId = 100;

    const result = await provision({
      ...baseOpts,
      managedDb: false,
    });

    expect(result.host).toBe("203.0.113.42");

    const dropletPosts = state.calls.filter(
      (c) => c.method === "POST" && c.url === "/v2/droplets",
    );
    expect(dropletPosts.length).toBe(0);
  });
});

describe("digitalocean.provision (managedDb=true)", () => {
  it("creates a managed Postgres cluster and returns the derived password URL", async () => {
    state = newState();
    installHandlers();

    const mnemonic = Buffer.from(TEST_MNEMONIC, "utf8");
    const expectedPassword = derivePassword(
      Buffer.from(TEST_MNEMONIC, "utf8"),
      "test",
      "db-password",
      32,
    );

    const result = await provision({
      ...baseOpts,
      managedDb: true,
      mnemonic,
    });

    expect(result.databaseUrl).toBeDefined();
    expect(result.databaseUrl).toContain(`app:${expectedPassword}@`);
    expect(result.databaseUrl).toContain(
      "db-uuid-0001.db.ondigitalocean.com:25060/app?sslmode=require",
    );

    expect(state.appDbCreated).toBe(true);
    expect(state.appUserCreated).toBe(true);
    expect(state.passwordResetTo).toBe(expectedPassword);

    // Firewall trusted sources include both the droplet and its IP.
    const rules = state.firewallRules as { type: string; value: string }[];
    expect(rules.some((r) => r.type === "droplet")).toBe(true);
    expect(rules.some((r) => r.type === "ip_addr" && r.value === "203.0.113.42")).toBe(true);
  });
});

describe("digitalocean.provision (managedDb=false)", () => {
  it("never touches the /v2/databases endpoints", async () => {
    state = newState();
    installHandlers();
    await provision({ ...baseOpts, managedDb: false });
    const dbCalls = state.calls.filter((c) => c.url.startsWith("/v2/databases"));
    expect(dbCalls.length).toBe(0);
  });
});

describe("digitalocean.provision (DIGITALOCEAN_TOKEN missing)", () => {
  it("fails clearly when neither token nor env var is present", async () => {
    state = newState();
    installHandlers();
    const previous = process.env.DIGITALOCEAN_TOKEN;
    delete process.env.DIGITALOCEAN_TOKEN;
    try {
      await expect(
        provision({
          env: "test",
          derivedDeployKeyPublicOpenSsh: DERIVED_DEPLOY_PUBLIC,
          managedDb: false,
        }),
      ).rejects.toThrow(/DIGITALOCEAN_TOKEN/);
    } finally {
      if (previous !== undefined) process.env.DIGITALOCEAN_TOKEN = previous;
    }
  });
});

describe("digitalocean.destroy", () => {
  it("deletes droplets, databases, and superfield-scoped ssh keys by tag", async () => {
    state = newState();
    installHandlers();
    state.tagExists = true;
    state.droplet = loadFixture("droplet-active");
    state.dropletStatus = "active";
    state.database = loadFixture("database-online");
    state.databaseStatus = "online";
    state.keys.push(
      {
        id: 1,
        name: "superfield-test-ephemeral-1",
        public_key: "ssh-ed25519 AAAA test1",
        fingerprint: "fp:1",
      },
      {
        id: 2,
        name: "superfield-test-deploy",
        public_key: "ssh-ed25519 AAAA test2",
        fingerprint: "fp:2",
      },
      {
        id: 3,
        name: "user-untouched",
        public_key: "ssh-ed25519 AAAA user",
        fingerprint: "fp:3",
      },
    );

    await destroy({ env: "test", token: "fake-token" });

    expect(state.droplet).toBeNull();
    expect(state.database).toBeNull();
    expect(state.keys.map((k) => k.id).sort()).toEqual([3]);
  });
});

describe("generateEphemeralSshKey", () => {
  it("returns OpenSSH public, PEM private, and an MD5 fingerprint", () => {
    const k = generateEphemeralSshKey();
    expect(k.publicKeyOpenSsh.startsWith("ssh-ed25519 ")).toBe(true);
    expect(k.privateKeyPem).toMatch(/BEGIN PRIVATE KEY/);
    expect(k.fingerprint).toMatch(/^[0-9a-f]{2}(:[0-9a-f]{2}){15}$/);
  });
});

describe("internal envTag", () => {
  it("formats env tags as superfield-env=<env>", () => {
    expect(__internal.envTag("staging")).toBe("superfield-env=staging");
  });
});
