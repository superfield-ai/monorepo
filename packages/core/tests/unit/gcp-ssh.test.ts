import { describe, it, expect, vi } from "vitest";
import { resolveSshKeyPath } from "../../gcp/ssh.ts";

// Mock the fs module
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
  };
});

describe("resolveSshKeyPath", () => {
  it("returns keyPath when provided", () => {
    const result = resolveSshKeyPath({ keyPath: "/custom/path/id_rsa" });
    expect(result).toBe("/custom/path/id_rsa");
  });

  it("returns undefined when no paths exist", async () => {
    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(false);
    const result = resolveSshKeyPath({});
    expect(result).toBeUndefined();
  });

  it("returns superfield_deploy path when it exists", async () => {
    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockImplementation((p) => {
      return String(p).endsWith("superfield_deploy");
    });
    const result = resolveSshKeyPath({});
    expect(result).toMatch(/superfield_deploy$/);
  });

  it("returns id_ed25519 when superfield_deploy does not exist but id_ed25519 does", async () => {
    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockImplementation((p) => {
      return String(p).endsWith("id_ed25519");
    });
    const result = resolveSshKeyPath({});
    expect(result).toMatch(/id_ed25519$/);
  });
});
