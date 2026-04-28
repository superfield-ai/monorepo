import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  provision,
  resourceNames,
  type ProvisionDeps,
} from "../../../../providers/gcp/index.ts";
import { derivePassword } from "../../../../secrets/index.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const FIXTURES_DIR = join(import.meta.dirname, "../../../fixtures/gcp");

function fixture<T = unknown>(name: string): T {
  const raw = readFileSync(join(FIXTURES_DIR, name), "utf8");
  return JSON.parse(raw) as T;
}

// ── Test mnemonic + constants ────────────────────────────────────────────────

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const TEST_DEPLOY_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPYEK/XIcf5LKf+WMtLKls0GQmoaTwKYMcoeUAFmR9wO";

const PROJECT_ID = "my-project";
const REGION = "us-central1";
const ZONE = "us-central1-a";
const ENV = "test";
const VM_EXTERNAL_IP = "203.0.113.42";
const ALLOYDB_PRIVATE_IP = "10.20.30.40";

// ── Stateful MSW server that records call sequence ──────────────────────────

interface RecordedCall {
  method: string;
  url: string;
  body?: unknown;
}

interface ServerState {
  calls: RecordedCall[];
  existingResources: Set<string>;
  vmCreated: boolean;
}

function makeState(opts: { existing?: string[] } = {}): ServerState {
  return {
    calls: [],
    existingResources: new Set(opts.existing ?? []),
    vmCreated: opts.existing?.some((u) => u.includes("/instances/")) ?? false,
  };
}

function makeHandlers(state: ServerState) {
  // Helper: record call, then choose response based on method/url.
  const record = async (request: Request): Promise<unknown | undefined> => {
    let body: unknown = undefined;
    if (request.method !== "GET" && request.method !== "DELETE") {
      try {
        body = await request.clone().json();
      } catch {
        body = undefined;
      }
    }
    state.calls.push({ method: request.method, url: request.url, body });
    return body;
  };

  // Operation polling — always DONE
  const opsHandler = http.all(
    "https://www.googleapis.com/compute/v1/operations/:id",
    async ({ request }) => {
      await record(request);
      return HttpResponse.json({ status: "DONE" });
    },
  );
  // Compute regional/zonal/global operations live under various paths; match broadly:
  const opsHandlerBroad = http.get(
    "https://www.googleapis.com/compute/v1/projects/:project/global/operations/:id",
    async ({ request }) => {
      await record(request);
      return HttpResponse.json({ status: "DONE" });
    },
  );
  const opsHandlerRegion = http.get(
    "https://www.googleapis.com/compute/v1/projects/:project/regions/:region/operations/:id",
    async ({ request }) => {
      await record(request);
      return HttpResponse.json({ status: "DONE" });
    },
  );
  const opsHandlerZone = http.get(
    "https://www.googleapis.com/compute/v1/projects/:project/zones/:zone/operations/:id",
    async ({ request }) => {
      await record(request);
      return HttpResponse.json({ status: "DONE" });
    },
  );
  const alloydbOps = http.get(
    "https://alloydb.googleapis.com/v1/projects/:project/locations/:loc/operations/:id",
    async ({ request }) => {
      await record(request);
      return HttpResponse.json({ status: "DONE", done: true });
    },
  );
  const serviceNetOps = http.get(
    "https://servicenetworking.googleapis.com/v1/operations/:id",
    async ({ request }) => {
      await record(request);
      return HttpResponse.json({ status: "DONE" });
    },
  );

  // Generic resource GET — 404 unless in existingResources
  const genericGet = http.get(
    "https://www.googleapis.com/compute/v1/*",
    async ({ request }) => {
      await record(request);
      const url = request.url;
      if (state.existingResources.has(url)) {
        if (url.includes("/instances/")) {
          return HttpResponse.json(fixture("vm-get.json"));
        }
        return HttpResponse.json({ name: "existing-resource" });
      }
      return new HttpResponse("Not Found", { status: 404 });
    },
  );

  // VM GET specifically — after a successful create, return the IP fixture
  const vmGet = http.get(
    `https://www.googleapis.com/compute/v1/projects/${PROJECT_ID}/zones/${ZONE}/instances/:name`,
    async ({ request }) => {
      await record(request);
      if (state.vmCreated || state.existingResources.has(request.url)) {
        return HttpResponse.json(fixture("vm-get.json"));
      }
      return new HttpResponse("Not Found", { status: 404 });
    },
  );

  // Compute POST — return immediate selfLink op
  const computePost = http.post(
    "https://www.googleapis.com/compute/v1/*",
    async ({ request }) => {
      await record(request);
      // Mark VM as created if this was a VM create
      if (request.url.includes("/instances")) {
        state.vmCreated = true;
      }
      return HttpResponse.json(fixture("compute-op-done.json"));
    },
  );

  // ── Service Networking
  const snList = http.get(
    "https://servicenetworking.googleapis.com/v1/services/servicenetworking.googleapis.com/connections",
    async ({ request }) => {
      await record(request);
      if (state.existingResources.has("vpc-peering")) {
        return HttpResponse.json({ connections: [{ name: "existing" }] });
      }
      return HttpResponse.json({ connections: [] });
    },
  );
  const snPost = http.post(
    "https://servicenetworking.googleapis.com/v1/services/servicenetworking.googleapis.com/connections",
    async ({ request }) => {
      await record(request);
      return HttpResponse.json(fixture("servicenet-op.json"));
    },
  );

  // ── AlloyDB
  const alloydbGet = http.get(
    "https://alloydb.googleapis.com/v1/*",
    async ({ request }) => {
      await record(request);
      if (state.existingResources.has(request.url)) {
        if (request.url.includes("/instances/")) {
          return HttpResponse.json(fixture("alloydb-instance-get.json"));
        }
        return HttpResponse.json({ name: "existing" });
      }
      // After instance create, return the instance with IP for the post-create GET
      if (
        request.url.includes("/instances/") &&
        state.calls.some(
          (c) =>
            c.method === "POST" &&
            c.url.includes("/clusters/") &&
            c.url.includes("instanceId="),
        )
      ) {
        return HttpResponse.json(fixture("alloydb-instance-get.json"));
      }
      return new HttpResponse("Not Found", { status: 404 });
    },
  );
  const alloydbPost = http.post(
    "https://alloydb.googleapis.com/v1/*",
    async ({ request }) => {
      await record(request);
      return HttpResponse.json(fixture("alloydb-op.json"));
    },
  );

  return [
    // Operations first (more specific)
    opsHandler,
    opsHandlerBroad,
    opsHandlerRegion,
    opsHandlerZone,
    alloydbOps,
    serviceNetOps,
    // Service Networking
    snList,
    snPost,
    // VM-specific GET (more specific than generic compute GET)
    vmGet,
    // AlloyDB
    alloydbGet,
    alloydbPost,
    // Generic compute (catch-all)
    computePost,
    genericGet,
  ];
}

// ── Test deps ────────────────────────────────────────────────────────────────

function makeDeps(): ProvisionDeps & { logs: string[] } {
  const logs: string[] = [];
  return {
    fetch: globalThis.fetch,
    getAccessToken: async () => "test-token",
    log: (msg) => {
      logs.push(msg);
    },
    logs,
  };
}

// ── MSW lifecycle ────────────────────────────────────────────────────────────

let server: ReturnType<typeof setupServer>;
let state: ServerState;

beforeAll(() => {
  server = setupServer();
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

function installHandlers(s: ServerState) {
  state = s;
  server.use(...makeHandlers(s));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("providers/gcp.provision", () => {
  it("first run hits the right endpoints in the right order (no managedDb)", async () => {
    installHandlers(makeState());
    const deps = makeDeps();

    const result = await provision(
      {
        projectId: PROJECT_ID,
        region: REGION,
        zone: ZONE,
        env: ENV,
        managedDb: false,
        derivedDeployKeyPublicOpenSsh: TEST_DEPLOY_KEY,
      },
      deps,
    );

    expect(result.host).toBe(VM_EXTERNAL_IP);
    expect(result.databaseUrl).toBeUndefined();
    expect(result.initialPrivateKeyPem).toMatch(/-----BEGIN PRIVATE KEY-----/);

    // Endpoint-order assertions: VPC → subnet → SSH firewall → VM (POST sequence)
    const posts = state.calls.filter((c) => c.method === "POST");
    const postPaths = posts.map((c) => c.url);
    expect(postPaths[0]).toContain("/global/networks");
    expect(postPaths[1]).toContain(`/regions/${REGION}/subnetworks`);
    expect(postPaths[2]).toContain("/global/firewalls");
    expect(postPaths[3]).toContain(`/zones/${ZONE}/instances`);

    // Created VM body has labels and SSH key metadata
    const vmCreate = posts[3]!.body as {
      labels?: Record<string, string>;
      machineType?: string;
      metadata?: { items?: Array<{ key: string; value: string }> };
    };
    expect(vmCreate.labels).toEqual({ "superfield-env": ENV });
    expect(vmCreate.machineType).toContain("e2-small");
    const sshItem = vmCreate.metadata?.items?.find((i) => i.key === "ssh-keys");
    expect(sshItem?.value).toContain(TEST_DEPLOY_KEY);
    expect(sshItem?.value).toMatch(/superfield:ssh-ed25519 \S+/);
  });

  it("does not touch AlloyDB endpoints when managedDb=false", async () => {
    installHandlers(makeState());
    const deps = makeDeps();

    await provision(
      {
        projectId: PROJECT_ID,
        region: REGION,
        zone: ZONE,
        env: ENV,
        managedDb: false,
        derivedDeployKeyPublicOpenSsh: TEST_DEPLOY_KEY,
      },
      deps,
    );

    const alloydbCalls = state.calls.filter((c) =>
      c.url.includes("alloydb.googleapis.com"),
    );
    const snCalls = state.calls.filter((c) =>
      c.url.includes("servicenetworking.googleapis.com"),
    );
    const psaCalls = state.calls.filter((c) => c.url.includes("/addresses"));
    expect(alloydbCalls).toEqual([]);
    expect(snCalls).toEqual([]);
    expect(psaCalls).toEqual([]);
  });

  it("returns a databaseUrl containing the derived password when managedDb=true", async () => {
    installHandlers(makeState());
    const deps = makeDeps();

    const expectedPassword = derivePassword(
      Buffer.from(TEST_MNEMONIC),
      ENV,
      "db-password",
      32,
    );

    const result = await provision(
      {
        projectId: PROJECT_ID,
        region: REGION,
        zone: ZONE,
        env: ENV,
        managedDb: true,
        derivedDeployKeyPublicOpenSsh: TEST_DEPLOY_KEY,
        mnemonic: Buffer.from(TEST_MNEMONIC),
      },
      deps,
    );

    expect(result.databaseUrl).toBeDefined();
    expect(result.databaseUrl).toBe(
      `postgresql://app:${expectedPassword}@${ALLOYDB_PRIVATE_IP}:5432/app`,
    );
  });

  it("second run with same labels detects existing VM and returns the same host", async () => {
    const names = resourceNames(ENV);
    const vmUrl = `https://www.googleapis.com/compute/v1/projects/${PROJECT_ID}/zones/${ZONE}/instances/${names.vm}`;
    const networkUrl = `https://www.googleapis.com/compute/v1/projects/${PROJECT_ID}/global/networks/${names.network}`;
    const subnetUrl = `https://www.googleapis.com/compute/v1/projects/${PROJECT_ID}/regions/${REGION}/subnetworks/${names.subnet}`;
    const fwUrl = `https://www.googleapis.com/compute/v1/projects/${PROJECT_ID}/global/firewalls/${names.sshFirewall}`;

    installHandlers(
      makeState({
        existing: [vmUrl, networkUrl, subnetUrl, fwUrl],
      }),
    );
    const deps = makeDeps();

    const result = await provision(
      {
        projectId: PROJECT_ID,
        region: REGION,
        zone: ZONE,
        env: ENV,
        managedDb: false,
        derivedDeployKeyPublicOpenSsh: TEST_DEPLOY_KEY,
      },
      deps,
    );

    expect(result.host).toBe(VM_EXTERNAL_IP);

    // No POSTs should have happened — every resource already existed.
    const posts = state.calls.filter((c) => c.method === "POST");
    expect(posts).toEqual([]);

    // And the logs should reflect "already exists" for each resource.
    const logsConcat = deps.logs.join("\n");
    expect(logsConcat).toContain("already exists");
    expect(logsConcat).toContain(names.vm);
  });
});
