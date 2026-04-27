import { describe, it, expect } from "vitest";
import { runDoctor } from "../../gcp/doctor.ts";
import type { DoctorDeps } from "../../gcp/doctor.ts";

const ACTIVE_PROJECT = {
  projectId: "my-project",
  projectNumber: "123456789",
  lifecycleState: "ACTIVE",
  name: "My Project",
};

const ALL_PROVISION_PERMISSIONS = [
  "resourcemanager.projects.get",
  "serviceusage.services.get",
  "serviceusage.services.enable",
  "compute.networks.get",
  "compute.networks.create",
  "compute.subnetworks.get",
  "compute.subnetworks.create",
  "compute.firewalls.get",
  "compute.firewalls.create",
  "compute.globalAddresses.get",
  "compute.globalAddresses.create",
  "compute.instances.get",
  "compute.instances.create",
  "compute.instances.start",
  "compute.images.useReadOnly",
  "compute.subnetworks.use",
  "compute.subnetworks.useExternalIp",
  "compute.globalOperations.get",
  "compute.regionOperations.get",
  "compute.zoneOperations.get",
  "servicenetworking.services.addPeering",
  "alloydb.clusters.get",
  "alloydb.clusters.create",
  "alloydb.instances.get",
  "alloydb.instances.create",
  "alloydb.operations.get",
];

const ALL_DEPLOY_PERMISSIONS = [
  "resourcemanager.projects.get",
  "compute.instances.get",
  "alloydb.clusters.get",
  "alloydb.instances.get",
];

const REQUIRED_SERVICES = [
  "compute.googleapis.com",
  "alloydb.googleapis.com",
  "serviceusage.googleapis.com",
  "servicenetworking.googleapis.com",
  "cloudresourcemanager.googleapis.com",
];

function makeDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    fetch: async () => new Response("{}", { status: 200 }),
    getAccessToken: async () => "test-token",
    getCredentialInfo: () => ({
      source: "GCP_ACCESS_TOKEN",
      type: "access-token",
    }),
    ...overrides,
  };
}

/**
 * Build a fetch mock that responds to the various GCP API endpoints used by runDoctor.
 */
function makeApiMock(options: {
  project?: object | null;
  grantedPermissions?: string[];
  enabledServices?: string[];
}) {
  const {
    project = ACTIVE_PROJECT,
    grantedPermissions = [],
    enabledServices = REQUIRED_SERVICES,
  } = options;

  return async (input: string | URL | Request): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    // Project GET
    if (
      /cloudresourcemanager.*\/projects\/[^:?]+$/.test(url) &&
      !url.includes(":testIamPermissions")
    ) {
      if (!project) {
        return new Response("Not Found", {
          status: 404,
          statusText: "Not Found",
        });
      }
      return new Response(JSON.stringify(project), { status: 200 });
    }

    // IAM permissions check
    if (url.includes(":testIamPermissions")) {
      return new Response(JSON.stringify({ permissions: grantedPermissions }), {
        status: 200,
      });
    }

    // Service state
    const serviceMatch = /\/services\/([^/?]+)$/.exec(url);
    if (serviceMatch?.[1]) {
      const service = serviceMatch[1];
      const state = enabledServices.includes(service) ? "ENABLED" : "DISABLED";
      return new Response(JSON.stringify({ state }), { status: 200 });
    }

    return new Response("{}", { status: 200 });
  };
}

describe("runDoctor", () => {
  it("returns ok=true when all permissions granted and all services enabled (provision)", async () => {
    const deps = makeDeps({
      fetch: makeApiMock({ grantedPermissions: ALL_PROVISION_PERMISSIONS }),
    });
    const result = await runDoctor(
      { mode: "provision", projectId: "my-project" },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(result.missingPermissions).toHaveLength(0);
    expect(result.disabledServices).toHaveLength(0);
    expect(result.projectId).toBe("my-project");
    expect(result.projectNumber).toBe("123456789");
  });

  it("returns ok=false when permissions are missing", async () => {
    const deps = makeDeps({
      // Only grant a subset of permissions
      fetch: makeApiMock({
        grantedPermissions: ["resourcemanager.projects.get"],
      }),
    });
    const result = await runDoctor(
      { mode: "provision", projectId: "my-project" },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.missingPermissions.length).toBeGreaterThan(0);
    expect(result.missingPermissions).not.toContain(
      "resourcemanager.projects.get",
    );
  });

  it("returns ok=false in provision mode when services disabled and cannot enable them", async () => {
    const deps = makeDeps({
      fetch: makeApiMock({
        grantedPermissions: ALL_PROVISION_PERMISSIONS.filter(
          (p) => p !== "serviceusage.services.enable",
        ),
        enabledServices: [],
      }),
    });
    const result = await runDoctor(
      { mode: "provision", projectId: "my-project" },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.disabledServices.length).toBeGreaterThan(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("returns ok=true in provision mode when services disabled but can enable them", async () => {
    const deps = makeDeps({
      fetch: makeApiMock({
        grantedPermissions: ALL_PROVISION_PERMISSIONS, // includes serviceusage.services.enable
        enabledServices: [],
      }),
    });
    const result = await runDoctor(
      { mode: "provision", projectId: "my-project" },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(result.disabledServices.length).toBeGreaterThan(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("throws when project metadata cannot be read (404)", async () => {
    const deps = makeDeps({
      fetch: makeApiMock({ project: null }),
    });
    await expect(
      runDoctor({ mode: "provision", projectId: "missing-project" }, deps),
    ).rejects.toThrow();
  });

  it("throws when project is not ACTIVE", async () => {
    const deps = makeDeps({
      fetch: makeApiMock({
        project: { ...ACTIVE_PROJECT, lifecycleState: "DELETE_REQUESTED" },
        grantedPermissions: ALL_PROVISION_PERMISSIONS,
      }),
    });
    await expect(
      runDoctor({ mode: "provision", projectId: "my-project" }, deps),
    ).rejects.toThrow("DELETE_REQUESTED");
  });

  it("deploy mode only checks deploy permissions (not provision permissions)", async () => {
    const deps = makeDeps({
      // Only grant deploy permissions (not provision ones like compute.instances.create)
      fetch: makeApiMock({ grantedPermissions: ALL_DEPLOY_PERMISSIONS }),
    });
    const result = await runDoctor(
      { mode: "deploy", projectId: "my-project" },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(result.missingPermissions).toHaveLength(0);
  });

  it("deploy mode does not check services (ok=true even with disabled services)", async () => {
    const deps = makeDeps({
      fetch: makeApiMock({
        grantedPermissions: ALL_DEPLOY_PERMISSIONS,
        enabledServices: [], // all disabled
      }),
    });
    const result = await runDoctor(
      { mode: "deploy", projectId: "my-project" },
      deps,
    );
    // Deploy mode doesn't care about service state for ok
    expect(result.ok).toBe(true);
  });
});
