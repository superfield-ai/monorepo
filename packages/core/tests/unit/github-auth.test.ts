import { describe, expect, it } from "vitest";

import { getAuthToken } from "../../github/auth.ts";

describe("getAuthToken", () => {
  it("returns the trimmed stdout from `gh auth token`", async () => {
    const token = await getAuthToken({
      spawnGhAuthToken: async () => ({
        stdout: "ghp_abc123\n",
        stderr: "",
        code: 0,
      }),
    });
    expect(token).toBe("ghp_abc123");
  });

  it("throws a clear error when gh exits non-zero", async () => {
    await expect(
      getAuthToken({
        spawnGhAuthToken: async () => ({
          stdout: "",
          stderr: "You are not logged in",
          code: 1,
        }),
      }),
    ).rejects.toThrow(/exited with code 1.*You are not logged in.*gh auth login/s);
  });

  it("throws when stdout is empty even on zero exit", async () => {
    await expect(
      getAuthToken({
        spawnGhAuthToken: async () => ({
          stdout: "   \n",
          stderr: "",
          code: 0,
        }),
      }),
    ).rejects.toThrow(/empty token/);
  });

  it("wraps spawn errors with a guidance message", async () => {
    await expect(
      getAuthToken({
        spawnGhAuthToken: async () => {
          throw new Error("ENOENT");
        },
      }),
    ).rejects.toThrow(/Failed to invoke 'gh auth token'.*GitHub CLI/s);
  });
});
