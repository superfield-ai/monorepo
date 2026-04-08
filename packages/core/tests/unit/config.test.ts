import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, saveConfig } from "../../config.ts";

async function tmpPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "superfield-test-"));
  return path.join(dir, "config.yaml");
}

describe("loadConfig", () => {
  it("returns empty config when file does not exist", async () => {
    const config = await loadConfig("/nonexistent/path/config.yaml");
    expect(config).toEqual({ users: [], repositories: [] });
  });

  it("parses a valid config file", async () => {
    const p = await tmpPath();
    await fs.writeFile(
      p,
      "users:\n  - handle: octocat\n    token: ghp_test\nrepositories:\n  - owner: my-org\n    repo: my-repo\n    assignedUser: octocat\n",
    );

    const config = await loadConfig(p);
    expect(config.users).toHaveLength(1);
    expect(config.users[0].handle).toBe("octocat");
    expect(config.repositories[0].repo).toBe("my-repo");
  });
});

describe("saveConfig", () => {
  it("writes config as YAML and can be read back", async () => {
    const p = await tmpPath();
    const original = {
      users: [{ handle: "octocat", token: "ghp_abc" }],
      repositories: [
        { owner: "my-org", repo: "my-repo", assignedUser: "octocat" },
      ],
    };

    await saveConfig(original, p);
    const loaded = await loadConfig(p);
    expect(loaded).toEqual(original);
  });

  it("creates parent directory if it does not exist", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "superfield-test-"));
    const p = path.join(dir, "nested", "config.yaml");
    await saveConfig({ users: [], repositories: [] }, p);
    const loaded = await loadConfig(p);
    expect(loaded).toEqual({ users: [], repositories: [] });
  });
});
