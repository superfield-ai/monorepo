import { describe, it, expect, vi } from "vitest";
import { runProvision } from "../../gcp/provision.ts";
import type { ProvisionConfig, ProvisionDeps } from "../../gcp/provision.ts";

const BASE_CONFIG: ProvisionConfig = {
  projectId: "my-project",
  region: "us-central1",
  zone: "us-central1-a",
  networkName: "superfield-vpc",
  subnetName: "superfield-subnet",
  subnetCidr: "10.0.0.0/24",
  podRangeName: "pods",
  podCidr: "10.1.0.0/16",
  serviceRangeName: "services",
  serviceCidr: "10.2.0.0/16",
  sshFirewallName: "superfield-ssh",
  appFirewallName: "superfield-app",
  appPort: "31415",
  psaAddressName: "superfield-psa",
  psaAddressCidr: "10.3.0.0/16",
  alloydbClusterId: "superfield-db",
  alloydbInstanceId: "superfield-db-primary",
  alloydbPassword: "s3cr3t",
  vmName: "superfield-vm",
  vmMachineType: "e2-standard-4",
  vmDiskSizeGb: 50,
  vmStartupScript: "#!/bin/bash\necho hello",
};

/** An operation response that looks "immediately DONE" when polled. */
function doneOpResponse(kind: "selfLink" | "name", id = "op-123") {
  if (kind === "selfLink") {
    return {
      selfLink: `https://www.googleapis.com/compute/v1/operations/${id}`,
    };
  }
  return { name: `operations/${id}` };
}

type FetchMock = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Build a fetch mock where every GET is a 404 (resource not found) and
 * every POST returns an immediate "DONE" operation.
 *
 * Optionally, `existingResources` can list URL substrings for which GET
 * should return 200 (resource exists).
 */
function makeAllNewFetch(
  existingResources: string[] = [],
  opKind: "selfLink" | "name" = "selfLink",
): FetchMock {
  return async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";

    // Operation polling — always return DONE
    if (
      url.includes("/operations/") ||
      url.match(/alloydb\.googleapis\.com\/v1\/operations\//)
    ) {
      return new Response(JSON.stringify({ status: "DONE" }), { status: 200 });
    }

    if (method === "GET") {
      // Service Networking list (returns empty connections)
      if (url.includes("servicenetworking") && url.includes("connections")) {
        const isExisting = existingResources.some((r) => url.includes(r));
        if (isExisting) {
          return new Response(
            JSON.stringify({ connections: [{ name: "existing" }] }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ connections: [] }), {
          status: 200,
        });
      }

      const isExisting = existingResources.some((r) => url.includes(r));
      if (isExisting) {
        return new Response(JSON.stringify({ name: "existing-resource" }), {
          status: 200,
        });
      }
      return new Response("Not Found", {
        status: 404,
        statusText: "Not Found",
      });
    }

    // POST — return an operation
    const opKindToUse = url.includes("alloydb.googleapis.com")
      ? "name"
      : opKind;
    return new Response(JSON.stringify(doneOpResponse(opKindToUse)), {
      status: 200,
    });
  };
}

function makeDeps(fetchFn: FetchMock): ProvisionDeps {
  const logs: string[] = [];
  return {
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      return fetchFn(url, init);
    },
    getAccessToken: async () => "test-token",
    log: (msg: string) => {
      logs.push(msg);
    },
  };
}

describe("runProvision", () => {
  it("happy path: creates all 9 resources when none exist", async () => {
    const fetchFn = vi.fn(makeAllNewFetch());
    const deps = makeDeps(fetchFn);

    await expect(runProvision(BASE_CONFIG, deps)).resolves.toBeUndefined();

    // Should have called POST for each of: network, subnet, ssh-fw, app-fw,
    // psa-address, sn-peering, alloydb-cluster, alloydb-instance, vm
    const postCalls = fetchFn.mock.calls.filter(
      ([, init]) => (init?.method ?? "GET") === "POST",
    );
    expect(postCalls.length).toBeGreaterThanOrEqual(9);
  });

  it("idempotent: skips all POSTs when every resource already exists", async () => {
    // Mark all resources as existing by passing substrings of their URLs
    const existing = [
      "superfield-vpc",
      "superfield-subnet",
      "superfield-ssh",
      "superfield-app",
      "superfield-psa",
      "servicenetworking", // peering check returns non-empty connections
      "superfield-db/instances/superfield-db-primary",
      "superfield-db",
      "superfield-vm",
    ];
    const fetchFn = vi.fn(makeAllNewFetch(existing));
    const deps = makeDeps(fetchFn);

    await expect(runProvision(BASE_CONFIG, deps)).resolves.toBeUndefined();

    const postCalls = fetchFn.mock.calls.filter(
      ([, init]) => (init?.method ?? "GET") === "POST",
    );
    expect(postCalls.length).toBe(0);
  });

  it("VPC creation: sends correct network name and autoCreateSubnetworks=false", async () => {
    const fetchFn = vi.fn(makeAllNewFetch());
    const deps = makeDeps(fetchFn);

    await runProvision(BASE_CONFIG, deps);

    const networkPost = fetchFn.mock.calls.find(([url, init]) => {
      return (
        (init?.method ?? "GET") === "POST" &&
        url.includes("/global/networks") &&
        !url.includes("firewalls") &&
        !url.includes("addresses")
      );
    });
    expect(networkPost).toBeDefined();
    if (networkPost) {
      const body = JSON.parse(networkPost[1]?.body as string);
      expect(body.name).toBe("superfield-vpc");
      expect(body.autoCreateSubnetworks).toBe(false);
    }
  });

  it("subnet creation: includes secondary IP ranges for pods and services", async () => {
    const fetchFn = vi.fn(makeAllNewFetch());
    const deps = makeDeps(fetchFn);

    await runProvision(BASE_CONFIG, deps);

    const subnetPost = fetchFn.mock.calls.find(([url, init]) => {
      return (
        (init?.method ?? "GET") === "POST" &&
        url.includes("/regions/us-central1/subnetworks")
      );
    });
    expect(subnetPost).toBeDefined();
    if (subnetPost) {
      const body = JSON.parse(subnetPost[1]?.body as string);
      expect(body.name).toBe("superfield-subnet");
      expect(body.ipCidrRange).toBe("10.0.0.0/24");
      expect(body.secondaryIpRanges).toHaveLength(2);
      const rangeNames = body.secondaryIpRanges.map(
        (r: { rangeName: string }) => r.rangeName,
      );
      expect(rangeNames).toContain("pods");
      expect(rangeNames).toContain("services");
    }
  });

  it("VM creation: includes startup-script metadata and correct machine type", async () => {
    const fetchFn = vi.fn(makeAllNewFetch());
    const deps = makeDeps(fetchFn);

    await runProvision(BASE_CONFIG, deps);

    const vmPost = fetchFn.mock.calls.find(([url, init]) => {
      return (
        (init?.method ?? "GET") === "POST" &&
        url.includes(`/zones/us-central1-a/instances`)
      );
    });
    expect(vmPost).toBeDefined();
    if (vmPost) {
      const body = JSON.parse(vmPost[1]?.body as string);
      expect(body.name).toBe("superfield-vm");
      expect(body.machineType).toContain("e2-standard-4");
      const startupItem = body.metadata?.items?.find(
        (item: { key: string }) => item.key === "startup-script",
      );
      expect(startupItem?.value).toBe("#!/bin/bash\necho hello");
    }
  });

  it("partial idempotency: skips VPC but creates subnet when only VPC exists", async () => {
    const fetchFn = vi.fn(makeAllNewFetch(["superfield-vpc"]));
    const deps = makeDeps(fetchFn);

    await runProvision(BASE_CONFIG, deps);

    // Network POST should NOT be called
    const networkPost = fetchFn.mock.calls.find(([url, init]) => {
      return (
        (init?.method ?? "GET") === "POST" &&
        url.includes("/global/networks") &&
        !url.includes("firewalls") &&
        !url.includes("addresses")
      );
    });
    expect(networkPost).toBeUndefined();

    // Subnet POST should be called
    const subnetPost = fetchFn.mock.calls.find(([url, init]) => {
      return (
        (init?.method ?? "GET") === "POST" &&
        url.includes("/regions/us-central1/subnetworks")
      );
    });
    expect(subnetPost).toBeDefined();
  });
});
