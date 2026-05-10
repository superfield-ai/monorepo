/**
 * Unit tests for the `ci` command argument parser.
 *
 * Verifies that parseCiArgs() maps CLI arg strings to the correct
 * structured option types without any side-effects.
 */

import { describe, it, expect } from "vitest";
import { parseCiArgs } from "../../commands/ci.ts";

describe("parseCiArgs — run subcommand", () => {
  it("parses 'run test-e2e.yml' without --vm", () => {
    const result = parseCiArgs(["run", "test-e2e.yml"]);
    expect(result.subcommand).toBe("run");
    if (result.subcommand !== "run") return;
    expect(result.opts.workflow).toBe("test-e2e.yml");
    expect(result.opts.vmExecutor).toBe(false);
  });

  it("parses 'run test-e2e.yml --vm' with vmExecutor true", () => {
    const result = parseCiArgs(["run", "test-e2e.yml", "--vm"]);
    expect(result.subcommand).toBe("run");
    if (result.subcommand !== "run") return;
    expect(result.opts.workflow).toBe("test-e2e.yml");
    expect(result.opts.vmExecutor).toBe(true);
  });

  it("parses --workspace-image flag", () => {
    const result = parseCiArgs([
      "run",
      "test-e2e.yml",
      "--vm",
      "--workspace-image",
      "docker.io/myorg/workspace:latest",
    ]);
    expect(result.subcommand).toBe("run");
    if (result.subcommand !== "run") return;
    expect(result.opts.workspaceImage).toBe("docker.io/myorg/workspace:latest");
  });

  it("parses --workspace-image=value form", () => {
    const result = parseCiArgs([
      "run",
      "test-e2e.yml",
      "--vm",
      "--workspace-image=docker.io/myorg/workspace:sha256",
    ]);
    expect(result.subcommand).toBe("run");
    if (result.subcommand !== "run") return;
    expect(result.opts.workspaceImage).toBe("docker.io/myorg/workspace:sha256");
  });

  it("parses --fastenv binary path", () => {
    const result = parseCiArgs([
      "run",
      "test-e2e.yml",
      "--vm",
      "--fastenv",
      "/usr/local/bin/fastenv",
    ]);
    expect(result.subcommand).toBe("run");
    if (result.subcommand !== "run") return;
    expect(result.opts.fastenvBinary).toBe("/usr/local/bin/fastenv");
  });

  it("returns help when workflow is missing", () => {
    const result = parseCiArgs(["run"]);
    expect(result.subcommand).toBe("help");
  });
});

describe("parseCiArgs — snapshot build subcommand", () => {
  it("parses required --tag and --rootfs flags", () => {
    const result = parseCiArgs([
      "snapshot",
      "build",
      "--tag",
      "sha256:abc123",
      "--rootfs",
      "/path/to/rootfs.ext4",
    ]);
    expect(result.subcommand).toBe("snapshot-build");
    if (result.subcommand !== "snapshot-build") return;
    expect(result.opts.tag).toBe("sha256:abc123");
    expect(result.opts.rootfsPath).toBe("/path/to/rootfs.ext4");
    expect(result.opts.binaryPath).toBeUndefined();
    expect(result.opts.kernelPath).toBeUndefined();
  });

  it("parses optional --binary and --kernel flags", () => {
    const result = parseCiArgs([
      "snapshot",
      "build",
      "--tag",
      "sha256:abc123",
      "--rootfs",
      "/rootfs.ext4",
      "--binary",
      "/usr/local/bin/firecracker",
      "--kernel",
      "/cache/vmlinux.bin",
    ]);
    expect(result.subcommand).toBe("snapshot-build");
    if (result.subcommand !== "snapshot-build") return;
    expect(result.opts.binaryPath).toBe("/usr/local/bin/firecracker");
    expect(result.opts.kernelPath).toBe("/cache/vmlinux.bin");
  });

  it("parses --tag=value= form", () => {
    const result = parseCiArgs([
      "snapshot",
      "build",
      "--tag=sha256:def456",
      "--rootfs=/rootfs.ext4",
    ]);
    expect(result.subcommand).toBe("snapshot-build");
    if (result.subcommand !== "snapshot-build") return;
    expect(result.opts.tag).toBe("sha256:def456");
    expect(result.opts.rootfsPath).toBe("/rootfs.ext4");
  });

  it("returns help when --tag is missing", () => {
    const result = parseCiArgs(["snapshot", "build", "--rootfs", "/r.ext4"]);
    expect(result.subcommand).toBe("help");
  });

  it("returns help when --rootfs is missing", () => {
    const result = parseCiArgs(["snapshot", "build", "--tag", "abc"]);
    expect(result.subcommand).toBe("help");
  });
});

describe("parseCiArgs — snapshot restore subcommand", () => {
  it("parses snapshot dir argument", () => {
    const result = parseCiArgs([
      "snapshot",
      "restore",
      "/tmp/snapshots/abc123",
    ]);
    expect(result.subcommand).toBe("snapshot-restore");
    if (result.subcommand !== "snapshot-restore") return;
    expect(result.opts.snapshotDir).toBe("/tmp/snapshots/abc123");
    expect(result.opts.workspaceDir).toBeUndefined();
  });

  it("parses optional --workspace flag (raw dir, debug only)", () => {
    const result = parseCiArgs([
      "snapshot",
      "restore",
      "/tmp/snapshots/abc123",
      "--workspace",
      "/home/user/project",
    ]);
    expect(result.subcommand).toBe("snapshot-restore");
    if (result.subcommand !== "snapshot-restore") return;
    expect(result.opts.workspaceDir).toBe("/home/user/project");
  });

  it("parses --workspace-image flag (fastenv COW fork)", () => {
    const result = parseCiArgs([
      "snapshot",
      "restore",
      "/tmp/snapshots/abc123",
      "--workspace-image",
      "docker.io/myorg/workspace:latest",
    ]);
    expect(result.subcommand).toBe("snapshot-restore");
    if (result.subcommand !== "snapshot-restore") return;
    expect(result.opts.workspaceImage).toBe("docker.io/myorg/workspace:latest");
    expect(result.opts.workspaceDir).toBeUndefined();
  });

  it("returns help when snapshot dir is missing", () => {
    const result = parseCiArgs(["snapshot", "restore"]);
    expect(result.subcommand).toBe("help");
  });
});

describe("parseCiArgs — help fallback", () => {
  it("returns help for empty args", () => {
    expect(parseCiArgs([]).subcommand).toBe("help");
  });

  it("returns help for --help flag", () => {
    expect(parseCiArgs(["--help"]).subcommand).toBe("help");
  });

  it("returns help for unknown subcommand", () => {
    expect(parseCiArgs(["unknown-subcommand"]).subcommand).toBe("help");
  });
});
