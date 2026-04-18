import { describe, it, expect, vi, beforeEach } from "vitest";
import { runGcpDeploy } from "../../gcp/deploy.ts";
import type { GcpDeployConfig, GcpDeployDeps } from "../../gcp/deploy.ts";

// Mock fs module to avoid real file system access
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

const RUNNING_VM = {
  status: "RUNNING",
  networkInterfaces: [
    {
      accessConfigs: [{ natIP: "1.2.3.4" }],
    },
  ],
};

const READY_CLUSTER = { state: "READY" };
const READY_INSTANCE = { state: "READY" };

function makeConfig(overrides: Partial<GcpDeployConfig> = {}): GcpDeployConfig {
  return {
    projectId: "test-project",
    region: "us-central1",
    zone: "us-central1-a",
    vmName: "test-vm",
    alloydbClusterId: "test-cluster",
    alloydbInstanceId: "test-instance",
    namespace: "default",
    secretName: "calypso-api-secrets",
    deploymentName: "calypso-api",
    imageTag: "sha-abc123",
    deployScript: "/repo/deploy.sh",
    sshUser: "root",
    talosMode: true, // use talosMode to avoid real SSH tunnel
    skipHttpCheck: true,
    ...overrides,
  };
}

function makeGoogleJsonRequestMock(responses: {
  vm?: object | null;
  cluster?: object | null;
  instance?: object | null;
}) {
  return vi.fn(async (url: string) => {
    if (url.includes("/instances/")) {
      return responses.vm ?? null;
    }
    if (url.includes("/instances/")) {
      return responses.instance ?? null;
    }
    if (url.includes("/clusters/") && !url.includes("/instances/")) {
      return responses.cluster ?? null;
    }
    if (url.includes("/clusters/")) {
      // could be cluster or instance URL
      if (url.match(/\/instances\/[^/]+$/)) {
        return responses.instance ?? null;
      }
      return responses.cluster ?? null;
    }
    return null;
  });
}

function makeApiMock(opts: {
  vm?: object | null;
  cluster?: object | null;
  instance?: object | null;
}) {
  return vi.fn(async (url: string) => {
    // VM instance URL: /compute/v1/projects/.../zones/.../instances/...
    if (/\/instances\/[^/]+$/.test(url) && url.includes("compute")) {
      return opts.vm ?? null;
    }
    // AlloyDB instance URL: .../clusters/.../instances/...
    if (/\/instances\/[^/]+$/.test(url) && url.includes("alloydb")) {
      return opts.instance ?? null;
    }
    // AlloyDB cluster URL: .../clusters/...
    if (/\/clusters\/[^/]+$/.test(url) && url.includes("alloydb")) {
      return opts.cluster ?? null;
    }
    return null;
  });
}

type ExecResult = { stdout: string; stderr: string; exitCode: number };

function makeExecMock(
  overrides: Record<string, ExecResult> = {},
) {
  return vi.fn(
    async (
      cmd: string,
      args: string[],
    ): Promise<ExecResult> => {
      // talosctl kubeconfig
      if (cmd === "talosctl" && args.includes("kubeconfig")) {
        return overrides["talosctl"] ?? { stdout: "apiVersion: v1\nkind: Config\n", stderr: "", exitCode: 0 };
      }

      // kubectl get namespace
      if (cmd === "kubectl" && args.includes("get") && args.includes("namespace")) {
        return overrides["kubectl-get-namespace"] ?? { stdout: "namespace found", stderr: "", exitCode: 0 };
      }

      // kubectl get secret
      if (cmd === "kubectl" && args.includes("get") && args.includes("secret")) {
        return overrides["kubectl-get-secret"] ?? { stdout: "secret found", stderr: "", exitCode: 0 };
      }

      // kubectl rollout status
      if (cmd === "kubectl" && args.includes("rollout")) {
        return overrides["kubectl-rollout"] ?? { stdout: "deployment rolled out", stderr: "", exitCode: 0 };
      }

      // kubectl annotate
      if (cmd === "kubectl" && args.includes("annotate")) {
        return overrides["kubectl-annotate"] ?? { stdout: "annotated", stderr: "", exitCode: 0 };
      }

      // deploy script
      if (args.includes("sha-abc123") || cmd.includes("deploy.sh")) {
        return overrides["deploy"] ?? { stdout: "deployed", stderr: "", exitCode: 0 };
      }

      return { stdout: "", stderr: "", exitCode: 0 };
    },
  );
}

function makeDeps(overrides: Partial<GcpDeployDeps> = {}): GcpDeployDeps {
  return {
    googleJsonRequest: makeApiMock({
      vm: RUNNING_VM,
      cluster: READY_CLUSTER,
      instance: READY_INSTANCE,
    }) as unknown as GcpDeployDeps["googleJsonRequest"],
    getAccessToken: async () => "test-token",
    fetch: async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
    exec: makeExecMock(),
    log: vi.fn(),
    isGitHubActions: false,
    ...overrides,
  };
}

describe("runGcpDeploy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear relevant env vars to not pollute tests
    delete process.env["GITHUB_RUN_ID"];
    delete process.env["GITHUB_ACTOR"];
  });

  it("happy path: VM RUNNING + AlloyDB READY + liveness checks pass + deploy.sh exits 0", async () => {
    const deps = makeDeps();
    await expect(runGcpDeploy(makeConfig(), deps)).resolves.toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("RUNNING"));
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining("completed successfully"),
    );
  });

  it("throws when VM is not RUNNING", async () => {
    const deps = makeDeps({
      googleJsonRequest: makeApiMock({
        vm: { status: "TERMINATED", networkInterfaces: [] },
        cluster: READY_CLUSTER,
        instance: READY_INSTANCE,
      }) as unknown as GcpDeployDeps["googleJsonRequest"],
    });
    await expect(runGcpDeploy(makeConfig(), deps)).rejects.toThrow(
      /not RUNNING.*TERMINATED/,
    );
  });

  it("throws when AlloyDB cluster is not READY", async () => {
    const deps = makeDeps({
      googleJsonRequest: makeApiMock({
        vm: RUNNING_VM,
        cluster: { state: "CREATING" },
        instance: READY_INSTANCE,
      }) as unknown as GcpDeployDeps["googleJsonRequest"],
    });
    await expect(runGcpDeploy(makeConfig(), deps)).rejects.toThrow(
      /not READY.*CREATING/,
    );
  });

  it("throws when deploy.sh exits non-zero", async () => {
    const deps = makeDeps({
      exec: makeExecMock({ deploy: { stdout: "", stderr: "image not found", exitCode: 1 } }),
    });
    await expect(runGcpDeploy(makeConfig(), deps)).rejects.toThrow(
      /Deploy script failed/,
    );
  });

  it("GitHub Actions annotation: kubectl annotate called when isGitHubActions === true and env has GITHUB_RUN_ID", async () => {
    process.env["GITHUB_RUN_ID"] = "12345";
    process.env["GITHUB_ACTOR"] = "octocat";

    const execMock = makeExecMock();
    const deps = makeDeps({
      exec: execMock,
      isGitHubActions: true,
    });

    await runGcpDeploy(makeConfig(), deps);

    // Find the annotate call
    const calls = vi.mocked(execMock).mock.calls;
    const annotateCall = calls.find(
      ([cmd, args]) => cmd === "kubectl" && args.includes("annotate"),
    );
    expect(annotateCall).toBeDefined();
    const annotateArgs = annotateCall![1] as string[];
    expect(annotateArgs.some((a) => a.includes("deploy.superfield.ai/actor=octocat"))).toBe(true);
    expect(annotateArgs.some((a) => a.includes("deploy.superfield.ai/run-id=12345"))).toBe(true);
    expect(annotateArgs.some((a) => a.includes("deploy.superfield.ai/image-tag=sha-abc123"))).toBe(true);
  });

  it("GitHub Actions annotation: kubectl annotate NOT called when isGitHubActions === false", async () => {
    process.env["GITHUB_RUN_ID"] = "12345";
    process.env["GITHUB_ACTOR"] = "octocat";

    const execMock = makeExecMock();
    const deps = makeDeps({
      exec: execMock,
      isGitHubActions: false,
    });

    await runGcpDeploy(makeConfig(), deps);

    const calls = vi.mocked(execMock).mock.calls;
    const annotateCall = calls.find(
      ([cmd, args]) => cmd === "kubectl" && args.includes("annotate"),
    );
    expect(annotateCall).toBeUndefined();
  });
});
