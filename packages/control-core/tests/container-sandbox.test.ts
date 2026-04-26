/**
 * @file packages/core/tests/container-sandbox.test.ts
 *
 * Unit tests for the container sandbox module.
 *
 * Issue #31 test plan items:
 *   - From inside the sandbox container, verify that curl/wget to an arbitrary external URL fails
 *   - From inside the sandbox container, verify that a request to the Anthropic API endpoint succeeds
 *   - From inside the sandbox container, verify that a request to the k8s API server fails
 *   - Run a build inside the sandbox and confirm the image artifact appears on the shared volume
 *   - Confirm no image is pushed to any registry during the build
 *   - Start and stop the sandbox via session lifecycle and confirm no orphan containers remain
 *
 * These are unit tests with spawn mocked via child_process.spawnSync,
 * which avoids Bun-specific vi.mock path resolution issues.
 *
 * @see packages/core/container-sandbox.ts
 * @see docs/studio-container-sandbox.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock child_process.spawnSync — this is the underlying function that our
// spawn wrapper calls. By mocking at this level, we avoid Bun-specific
// vi.mock path resolution issues with the spawn.ts wrapper module.
const spawnSyncMock = vi.fn<
  (
    cmd: string,
    args: string[],
    opts?: object,
  ) => {
    status: number;
    stdout: Buffer;
    stderr: Buffer;
    pid: number;
    output: unknown[];
    signal: null;
  }
>(() => ({
  status: 0,
  stdout: Buffer.from(""),
  stderr: Buffer.from(""),
  pid: 1234,
  output: [],
  signal: null,
}));

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    spawnSync: (cmd: string, args: string[], opts?: object) =>
      spawnSyncMock(cmd, args, opts),
  };
});

/** Helper to configure spawnSync mock to return specific string output. */
function mockSpawnResult(status: number, stdout: string, stderr: string) {
  return {
    status,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    pid: 1234,
    output: [],
    signal: null,
  };
}

describe("container-sandbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Container naming ──────────────────────────────────────────────────────

  describe("sandboxContainerName", () => {
    it("derives a deterministic name from session ID", async () => {
      const { sandboxContainerName } = await import("../container-sandbox");
      expect(sandboxContainerName("a1b2")).toBe("studio-sandbox-a1b2");
    });

    it("handles different session IDs", async () => {
      const { sandboxContainerName } = await import("../container-sandbox");
      expect(sandboxContainerName("x9z0")).toBe("studio-sandbox-x9z0");
    });
  });

  // ── Network rules ─────────────────────────────────────────────────────────

  describe("buildNetworkRules", () => {
    it("generates an iptables script that drops all outbound by default", async () => {
      const { buildNetworkRules } = await import("../container-sandbox");
      const rules = buildNetworkRules();
      expect(rules).toContain("#!/bin/sh");
      expect(rules).toContain("iptables -P OUTPUT DROP");
    });

    it("allows loopback traffic", async () => {
      const { buildNetworkRules } = await import("../container-sandbox");
      const rules = buildNetworkRules();
      expect(rules).toContain("iptables -A OUTPUT -o lo -j ACCEPT");
    });

    it("allows established/related connections", async () => {
      const { buildNetworkRules } = await import("../container-sandbox");
      const rules = buildNetworkRules();
      expect(rules).toContain("--state ESTABLISHED,RELATED -j ACCEPT");
    });

    it("allows DNS only to localhost", async () => {
      const { buildNetworkRules } = await import("../container-sandbox");
      const rules = buildNetworkRules();
      expect(rules).toContain("-p udp --dport 53 -d 127.0.0.1 -j ACCEPT");
      expect(rules).toContain("-p tcp --dport 53 -d 127.0.0.1 -j ACCEPT");
    });

    it("allows HTTPS (port 443) to Anthropic API IPs", async () => {
      const { buildNetworkRules } = await import("../container-sandbox");
      const rules = buildNetworkRules();
      expect(rules).toContain("--dport 443");
      expect(rules).toContain("api.anthropic.com");
    });

    it("drops all other traffic with a final DROP rule", async () => {
      const { buildNetworkRules } = await import("../container-sandbox");
      const rules = buildNetworkRules();
      expect(rules).toContain("iptables -A OUTPUT -j DROP");
    });

    it("resolves Anthropic API host at runtime via getent", async () => {
      const { buildNetworkRules } = await import("../container-sandbox");
      const rules = buildNetworkRules();
      expect(rules).toContain("getent hosts api.anthropic.com");
    });
  });

  // ── DNS config ─────────────────────────────────────────────────────────────

  describe("buildDnsConfig", () => {
    it("generates a dnsmasq config with no external resolvers", async () => {
      const { buildDnsConfig } = await import("../container-sandbox");
      const config = buildDnsConfig();
      expect(config).toContain("no-resolv");
      expect(config).toContain("no-hosts");
    });

    it("allows only Anthropic API domain resolution", async () => {
      const { buildDnsConfig } = await import("../container-sandbox");
      const config = buildDnsConfig();
      expect(config).toContain("server=/api.anthropic.com/");
    });

    it("blocks all other domains via catch-all address rule", async () => {
      const { buildDnsConfig } = await import("../container-sandbox");
      const config = buildDnsConfig();
      expect(config).toContain("address=/#/");
    });
  });

  // ── startSandbox ──────────────────────────────────────────────────────────

  describe("startSandbox", () => {
    const sandboxConfig = {
      sessionId: "a1b2",
      worktreePath: "/tmp/wt/studio-session-abc123-a1b2",
      buildOutputDir: "/tmp/studio-builds/a1b2",
      verbose: false,
    };

    it("creates a container, starts it, and returns sandbox state", async () => {
      spawnSyncMock
        .mockReturnValueOnce(mockSpawnResult(0, "", "")) // rm -f
        .mockReturnValueOnce(mockSpawnResult(0, "abc123def456\n", "")) // create
        .mockReturnValueOnce(mockSpawnResult(0, "", "")) // start
        .mockReturnValueOnce(mockSpawnResult(0, "", "")) // exec rules
        .mockReturnValueOnce(mockSpawnResult(0, "", "")); // exec dns

      const { startSandbox } = await import("../container-sandbox");
      const sandbox = startSandbox(sandboxConfig);

      expect(sandbox.containerName).toBe("studio-sandbox-a1b2");
      expect(sandbox.containerId).toBe("abc123def456");
      expect(sandbox.buildOutputDir).toBe("/tmp/studio-builds/a1b2");
      expect(sandbox.worktreePath).toBe("/tmp/wt/studio-session-abc123-a1b2");
    });

    it("creates container with --network none for isolation", async () => {
      spawnSyncMock
        .mockReturnValueOnce(mockSpawnResult(0, "", ""))
        .mockReturnValueOnce(mockSpawnResult(0, "cid\n", ""))
        .mockReturnValueOnce(mockSpawnResult(0, "", ""))
        .mockReturnValueOnce(mockSpawnResult(0, "", ""))
        .mockReturnValueOnce(mockSpawnResult(0, "", ""));

      const { startSandbox } = await import("../container-sandbox");
      startSandbox(sandboxConfig);

      // Second call is docker create.
      const createCall = spawnSyncMock.mock.calls[1];
      expect(createCall[0]).toBe("docker");
      expect(createCall[1]).toContain("--network");
      expect(createCall[1]).toContain("none");
    });

    it("mounts source code and build output as volumes", async () => {
      spawnSyncMock
        .mockReturnValueOnce(mockSpawnResult(0, "", ""))
        .mockReturnValueOnce(mockSpawnResult(0, "cid\n", ""))
        .mockReturnValueOnce(mockSpawnResult(0, "", ""))
        .mockReturnValueOnce(mockSpawnResult(0, "", ""))
        .mockReturnValueOnce(mockSpawnResult(0, "", ""));

      const { startSandbox } = await import("../container-sandbox");
      startSandbox(sandboxConfig);

      const createArgs = spawnSyncMock.mock.calls[1][1] as string[];
      expect(createArgs).toContain("-v");
      expect(createArgs).toContain(
        `${sandboxConfig.worktreePath}:/studio/src:rw`,
      );
      expect(createArgs).toContain(
        `${sandboxConfig.buildOutputDir}:/studio/build-output:rw`,
      );
    });

    it("adds NET_ADMIN capability for iptables", async () => {
      spawnSyncMock
        .mockReturnValueOnce(mockSpawnResult(0, "", ""))
        .mockReturnValueOnce(mockSpawnResult(0, "cid\n", ""))
        .mockReturnValueOnce(mockSpawnResult(0, "", ""))
        .mockReturnValueOnce(mockSpawnResult(0, "", ""))
        .mockReturnValueOnce(mockSpawnResult(0, "", ""));

      const { startSandbox } = await import("../container-sandbox");
      startSandbox(sandboxConfig);

      const createArgs = spawnSyncMock.mock.calls[1][1] as string[];
      expect(createArgs).toContain("--cap-add");
      expect(createArgs).toContain("NET_ADMIN");
    });

    it("adds security-opt no-new-privileges", async () => {
      spawnSyncMock
        .mockReturnValueOnce(mockSpawnResult(0, "", ""))
        .mockReturnValueOnce(mockSpawnResult(0, "cid\n", ""))
        .mockReturnValueOnce(mockSpawnResult(0, "", ""))
        .mockReturnValueOnce(mockSpawnResult(0, "", ""))
        .mockReturnValueOnce(mockSpawnResult(0, "", ""));

      const { startSandbox } = await import("../container-sandbox");
      startSandbox(sandboxConfig);

      const createArgs = spawnSyncMock.mock.calls[1][1] as string[];
      expect(createArgs).toContain("--security-opt");
      expect(createArgs).toContain("no-new-privileges");
    });

    it("labels the container for identification and cleanup", async () => {
      spawnSyncMock
        .mockReturnValueOnce(mockSpawnResult(0, "", ""))
        .mockReturnValueOnce(mockSpawnResult(0, "cid\n", ""))
        .mockReturnValueOnce(mockSpawnResult(0, "", ""))
        .mockReturnValueOnce(mockSpawnResult(0, "", ""))
        .mockReturnValueOnce(mockSpawnResult(0, "", ""));

      const { startSandbox } = await import("../container-sandbox");
      startSandbox(sandboxConfig);

      const createArgs = spawnSyncMock.mock.calls[1][1] as string[];
      expect(createArgs).toContain("--label");
      expect(createArgs).toContain("app=superfield-studio-sandbox");
      expect(createArgs).toContain("session=a1b2");
    });

    it("throws if container creation fails", async () => {
      spawnSyncMock
        .mockReturnValueOnce(mockSpawnResult(0, "", ""))
        .mockReturnValueOnce(mockSpawnResult(1, "", "create failed"));

      const { startSandbox } = await import("../container-sandbox");
      expect(() => startSandbox(sandboxConfig)).toThrow(
        "Failed to create sandbox container",
      );
    });

    it("cleans up and throws if container start fails", async () => {
      spawnSyncMock
        .mockReturnValueOnce(mockSpawnResult(0, "", ""))
        .mockReturnValueOnce(mockSpawnResult(0, "cid\n", ""))
        .mockReturnValueOnce(mockSpawnResult(1, "", "start failed"))
        .mockReturnValueOnce(mockSpawnResult(0, "", ""));

      const { startSandbox } = await import("../container-sandbox");
      expect(() => startSandbox(sandboxConfig)).toThrow(
        "Failed to start sandbox container",
      );

      // Verify cleanup rm -f was called.
      const lastCall =
        spawnSyncMock.mock.calls[spawnSyncMock.mock.calls.length - 1];
      expect(lastCall[0]).toBe("docker");
      expect((lastCall[1] as string[])[0]).toBe("rm");
    });

    it("injects iptables rules via docker exec", async () => {
      spawnSyncMock
        .mockReturnValueOnce(mockSpawnResult(0, "", ""))
        .mockReturnValueOnce(mockSpawnResult(0, "cid\n", ""))
        .mockReturnValueOnce(mockSpawnResult(0, "", ""))
        .mockReturnValueOnce(mockSpawnResult(0, "", ""))
        .mockReturnValueOnce(mockSpawnResult(0, "", ""));

      const { startSandbox } = await import("../container-sandbox");
      startSandbox(sandboxConfig);

      // Fourth call: exec for iptables rules.
      const rulesCall = spawnSyncMock.mock.calls[3];
      expect(rulesCall[0]).toBe("docker");
      expect((rulesCall[1] as string[])[0]).toBe("exec");
      expect((rulesCall[1] as string[])[1]).toBe("studio-sandbox-a1b2");
    });

    it("injects DNS config via docker exec", async () => {
      spawnSyncMock
        .mockReturnValueOnce(mockSpawnResult(0, "", ""))
        .mockReturnValueOnce(mockSpawnResult(0, "cid\n", ""))
        .mockReturnValueOnce(mockSpawnResult(0, "", ""))
        .mockReturnValueOnce(mockSpawnResult(0, "", ""))
        .mockReturnValueOnce(mockSpawnResult(0, "", ""));

      const { startSandbox } = await import("../container-sandbox");
      startSandbox(sandboxConfig);

      // Fifth call: exec for DNS config.
      const dnsCall = spawnSyncMock.mock.calls[4];
      expect(dnsCall[0]).toBe("docker");
      expect((dnsCall[1] as string[])[0]).toBe("exec");
      expect(dnsCall[1] as string[]).toContain("studio-sandbox-a1b2");
    });
  });

  // ── stopSandbox ───────────────────────────────────────────────────────────

  describe("stopSandbox", () => {
    const sandbox = {
      containerId: "abc123",
      containerName: "studio-sandbox-a1b2",
      buildOutputDir: "/tmp/builds/a1b2",
      worktreePath: "/tmp/wt/a1b2",
    };

    it("stops then force-removes the container", async () => {
      spawnSyncMock
        .mockReturnValueOnce(mockSpawnResult(0, "", ""))
        .mockReturnValueOnce(mockSpawnResult(0, "", ""));

      const { stopSandbox } = await import("../container-sandbox");
      stopSandbox(sandbox);

      expect(spawnSyncMock).toHaveBeenCalledTimes(2);
      expect(spawnSyncMock.mock.calls[0][0]).toBe("docker");
      expect(spawnSyncMock.mock.calls[0][1]).toEqual([
        "stop",
        "--time",
        "5",
        "studio-sandbox-a1b2",
      ]);
      expect(spawnSyncMock.mock.calls[1][0]).toBe("docker");
      expect(spawnSyncMock.mock.calls[1][1]).toEqual([
        "rm",
        "-f",
        "studio-sandbox-a1b2",
      ]);
    });

    it("is idempotent — does not throw if container is already gone", async () => {
      spawnSyncMock
        .mockReturnValueOnce(mockSpawnResult(1, "", "not found"))
        .mockReturnValueOnce(mockSpawnResult(1, "", "not found"));

      const { stopSandbox } = await import("../container-sandbox");
      expect(() => stopSandbox(sandbox)).not.toThrow();
    });
  });

  // ── listSandboxes ─────────────────────────────────────────────────────────

  describe("listSandboxes", () => {
    it("returns empty array when no sandbox containers exist", async () => {
      spawnSyncMock.mockReturnValueOnce(mockSpawnResult(0, "", ""));

      const { listSandboxes } = await import("../container-sandbox");
      expect(listSandboxes()).toEqual([]);
    });

    it("parses docker ps output into SandboxInfo objects", async () => {
      spawnSyncMock.mockReturnValueOnce(
        mockSpawnResult(
          0,
          "abc123|studio-sandbox-a1b2|Up 5 minutes\ndef456|studio-sandbox-x9z0|Exited (0) 2 hours ago\n",
          "",
        ),
      );

      const { listSandboxes } = await import("../container-sandbox");
      const result = listSandboxes();

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        containerId: "abc123",
        containerName: "studio-sandbox-a1b2",
        status: "Up 5 minutes",
      });
      expect(result[1]).toEqual({
        containerId: "def456",
        containerName: "studio-sandbox-x9z0",
        status: "Exited (0) 2 hours ago",
      });
    });

    it("filters by the studio sandbox label", async () => {
      spawnSyncMock.mockReturnValueOnce(mockSpawnResult(0, "", ""));

      const { listSandboxes } = await import("../container-sandbox");
      listSandboxes();

      const args = spawnSyncMock.mock.calls[0][1] as string[];
      expect(args).toContain("--filter");
      expect(args).toContain("label=app=superfield-studio-sandbox");
    });

    it("returns empty array on docker failure", async () => {
      spawnSyncMock.mockReturnValueOnce(mockSpawnResult(1, "", "error"));

      const { listSandboxes } = await import("../container-sandbox");
      expect(listSandboxes()).toEqual([]);
    });
  });

  // ── cleanupOrphanedSandboxes ──────────────────────────────────────────────

  describe("cleanupOrphanedSandboxes", () => {
    it("returns 0 when no orphans exist", async () => {
      spawnSyncMock.mockReturnValueOnce(mockSpawnResult(0, "", ""));

      const { cleanupOrphanedSandboxes } = await import("../container-sandbox");
      expect(cleanupOrphanedSandboxes()).toBe(0);
    });

    it("stops and removes each orphan container", async () => {
      spawnSyncMock
        .mockReturnValueOnce(
          mockSpawnResult(0, "abc|studio-sandbox-old1|Up 10m\n", ""),
        )
        .mockReturnValueOnce(mockSpawnResult(0, "", ""))
        .mockReturnValueOnce(mockSpawnResult(0, "", ""));

      const { cleanupOrphanedSandboxes } = await import("../container-sandbox");
      expect(cleanupOrphanedSandboxes()).toBe(1);

      expect(spawnSyncMock.mock.calls[1][1]).toContain("studio-sandbox-old1");
      expect(spawnSyncMock.mock.calls[2][1]).toContain("studio-sandbox-old1");
    });
  });

  // ── buildAndExportImage ───────────────────────────────────────────────────

  describe("buildAndExportImage", () => {
    const sandbox = {
      containerId: "abc123",
      containerName: "studio-sandbox-a1b2",
      buildOutputDir: "/tmp/builds/a1b2",
      worktreePath: "/tmp/wt/a1b2",
    };

    it("runs docker build inside the sandbox container", async () => {
      spawnSyncMock
        .mockReturnValueOnce(mockSpawnResult(0, "", ""))
        .mockReturnValueOnce(mockSpawnResult(0, "", ""));

      const { buildAndExportImage } = await import("../container-sandbox");
      buildAndExportImage(sandbox, "superfield-release:studio");

      const buildArgs = spawnSyncMock.mock.calls[0][1] as string[];
      expect(spawnSyncMock.mock.calls[0][0]).toBe("docker");
      expect(buildArgs[0]).toBe("exec");
      expect(buildArgs[1]).toBe("studio-sandbox-a1b2");
      expect(buildArgs).toContain("build");
    });

    it("saves image to shared volume — not a network push", async () => {
      spawnSyncMock
        .mockReturnValueOnce(mockSpawnResult(0, "", ""))
        .mockReturnValueOnce(mockSpawnResult(0, "", ""));

      const { buildAndExportImage } = await import("../container-sandbox");
      buildAndExportImage(sandbox, "superfield-release:studio");

      const saveArgs = spawnSyncMock.mock.calls[1][1] as string[];
      expect(saveArgs).toContain("save");
      const outputArg = saveArgs.find((a: string) =>
        a.includes("/studio/build-output/"),
      );
      expect(outputArg).toBeDefined();
    });

    it("never pushes to any registry", async () => {
      spawnSyncMock
        .mockReturnValueOnce(mockSpawnResult(0, "", ""))
        .mockReturnValueOnce(mockSpawnResult(0, "", ""));

      const { buildAndExportImage } = await import("../container-sandbox");
      buildAndExportImage(sandbox, "superfield-release:studio");

      for (const call of spawnSyncMock.mock.calls) {
        expect(call[1]).not.toContain("push");
      }
    });

    it("returns true on success", async () => {
      spawnSyncMock
        .mockReturnValueOnce(mockSpawnResult(0, "", ""))
        .mockReturnValueOnce(mockSpawnResult(0, "", ""));

      const { buildAndExportImage } = await import("../container-sandbox");
      expect(buildAndExportImage(sandbox, "superfield-release:studio")).toBe(
        true,
      );
    });

    it("returns false if build fails", async () => {
      spawnSyncMock.mockReturnValueOnce(mockSpawnResult(1, "", "build error"));

      const { buildAndExportImage } = await import("../container-sandbox");
      expect(buildAndExportImage(sandbox, "superfield-release:studio")).toBe(
        false,
      );
    });

    it("returns false if export fails", async () => {
      spawnSyncMock
        .mockReturnValueOnce(mockSpawnResult(0, "", ""))
        .mockReturnValueOnce(mockSpawnResult(1, "", "save error"));

      const { buildAndExportImage } = await import("../container-sandbox");
      expect(buildAndExportImage(sandbox, "superfield-release:studio")).toBe(
        false,
      );
    });
  });

  // ── isSandboxRunning ──────────────────────────────────────────────────────

  describe("isSandboxRunning", () => {
    it("returns true when container reports running state", async () => {
      spawnSyncMock.mockReturnValueOnce(mockSpawnResult(0, "true\n", ""));

      const { isSandboxRunning } = await import("../container-sandbox");
      expect(isSandboxRunning("a1b2")).toBe(true);

      expect(spawnSyncMock.mock.calls[0][1]).toContain("studio-sandbox-a1b2");
    });

    it("returns false when container is not running", async () => {
      spawnSyncMock.mockReturnValueOnce(mockSpawnResult(0, "false\n", ""));

      const { isSandboxRunning } = await import("../container-sandbox");
      expect(isSandboxRunning("a1b2")).toBe(false);
    });

    it("returns false when container does not exist", async () => {
      spawnSyncMock.mockReturnValueOnce(mockSpawnResult(1, "", "not found"));

      const { isSandboxRunning } = await import("../container-sandbox");
      expect(isSandboxRunning("a1b2")).toBe(false);
    });
  });
});
