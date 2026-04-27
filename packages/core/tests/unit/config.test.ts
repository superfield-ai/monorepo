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
    expect(config.users[0]!.handle).toBe("octocat");
    expect(config.repositories[0]!.repo).toBe("my-repo");
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

describe("tiers and jobs config fields", () => {
  it("loads tiers overrides from YAML", async () => {
    const p = await tmpPath();
    await fs.writeFile(
      p,
      [
        "users: []",
        "repositories: []",
        "tiers:",
        "  thinking-medium:",
        "    - backend: codex",
        "      model: gpt-5.4",
      ].join("\n"),
    );
    const config = await loadConfig(p);
    expect(config.tiers).toEqual({
      "thinking-medium": [{ backend: "codex", model: "gpt-5.4" }],
    });
  });

  it("loads jobs overrides from YAML", async () => {
    const p = await tmpPath();
    await fs.writeFile(
      p,
      [
        "users: []",
        "repositories: []",
        "jobs:",
        "  plan:",
        "    preferred:",
        "      backend: codex",
        "      tier: high",
        "    failovers:",
        "      - thinking-high",
      ].join("\n"),
    );
    const config = await loadConfig(p);
    expect(config.jobs?.["plan"]).toEqual({
      preferred: { backend: "codex", tier: "high" },
      failovers: ["thinking-high"],
    });
  });

  it("omits tiers and jobs when not present in YAML", async () => {
    const p = await tmpPath();
    await fs.writeFile(p, "users: []\nrepositories: []\n");
    const config = await loadConfig(p);
    expect(config.tiers).toBeUndefined();
    expect(config.jobs).toBeUndefined();
  });

  it("preserves unrelated fields when only tiers is overridden", async () => {
    const p = await tmpPath();
    await fs.writeFile(
      p,
      [
        "users:",
        "  - handle: octocat",
        "    token: ghp_test",
        "repositories: []",
        "tiers:",
        "  thinking-low:",
        "    - backend: opencode",
        "      model: opencode/cheap",
      ].join("\n"),
    );
    const config = await loadConfig(p);
    expect(config.users[0]?.handle).toBe("octocat");
    expect(config.tiers?.["thinking-low"]).toBeDefined();
    expect(config.jobs).toBeUndefined();
  });
});
