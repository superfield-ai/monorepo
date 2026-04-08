/**
 * Integration tests for `runGithubAdd` that mock at the HTTP layer (MSW)
 * and wire the real GitHubClient into deps — exactly as the production
 * `githubCommand` does.  This catches regressions where the client +
 * command interact unexpectedly (e.g. the polling hang when GitHub App
 * was removed or re-installed on different repos out-of-band).
 */

import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { GitHubClient } from "@superfield/github";
import { runGithubAdd, type GithubDeps } from "../../commands/github.ts";
import type { Config } from "@superfield/core";

import installationsEmpty from "../../../../tests/fixtures/github/user-installations-empty.json";
import installationsPersonalSelected from "../../../../tests/fixtures/github/user-installations-personal-selected.json";
import installationsAllRepos from "../../../../tests/fixtures/github/user-installations-all-repos.json";
import installationRepos from "../../../../tests/fixtures/github/installation-repos.json";

const BASE = "https://api.github.com";
const TOKEN = "ghu_test_integration";
const INSTALLATION_ID = installationsPersonalSelected.installations[0]!.id;

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** Real checkAppInstalled wired to GitHubClient — identical to production. */
async function checkAppInstalled(
  token: string,
  _appSlug: string,
): Promise<string[] | "all" | null> {
  const client = new GitHubClient(token);
  const installations = await client.listAllInstallations();
  if (installations.length === 0) return null;
  if (installations.some((inst) => inst.repositorySelection === "all"))
    return "all";
  const repoLists = await Promise.all(
    installations.map((inst) => client.listInstallationRepos(inst.id)),
  );
  return repoLists.flat();
}

function makeDeps(config: Config, overrides: Partial<GithubDeps> = {}): GithubDeps {
  return {
    loadConfig: vi.fn().mockResolvedValue(config),
    saveConfig: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn(),
    log: vi.fn(),
    error: vi.fn(),
    env: {},
    requestDeviceCode: vi.fn(),
    pollAccessToken: vi.fn(),
    fetchUserLogin: vi.fn().mockResolvedValue("0o-de-lally"),
    checkAppInstalled,
    getInstallation: vi.fn().mockResolvedValue(null),
    resolveRepo: vi.fn().mockResolvedValue({ owner: "0o-de-lally", repo: "coco" }),
    ...overrides,
  };
}

describe("github add — integration (MSW + real GitHubClient)", () => {
  it("detects app installed with selected repos and syncs all of them into config", async () => {
    server.use(
      http.get(`${BASE}/user/installations`, () =>
        HttpResponse.json(installationsPersonalSelected),
      ),
      http.get(`${BASE}/user/installations/${INSTALLATION_ID}/repositories`, () =>
        HttpResponse.json(installationRepos),
      ),
    );

    const config: Config = { users: [{ handle: "0o-de-lally", token: TOKEN }], repositories: [] };
    const deps = makeDeps(config, {
      // target is one of the repos in the fixture
      resolveRepo: vi.fn().mockResolvedValue({ owner: "0o-de-lally", repo: "coco" }),
    });

    await runGithubAdd(undefined, deps);

    // All 4 repos from the fixture should be synced
    expect(config.repositories.map((r) => `${r.owner}/${r.repo}`).sort()).toEqual([
      "0o-de-lally/ai-notes",
      "0o-de-lally/app",
      "0o-de-lally/atomica",
      "0o-de-lally/coco",
    ]);
    expect(deps.saveConfig).toHaveBeenCalledTimes(1);
  });

  it("detects all-repos installation and adds only target to config", async () => {
    server.use(
      http.get(`${BASE}/user/installations`, () =>
        HttpResponse.json(installationsAllRepos),
      ),
    );

    const config: Config = { users: [{ handle: "0o-de-lally", token: TOKEN }], repositories: [] };
    const deps = makeDeps(config, {
      resolveRepo: vi.fn().mockResolvedValue({ owner: "0o-de-lally", repo: "coco" }),
    });

    await runGithubAdd(undefined, deps);

    expect(config.repositories).toEqual([
      { owner: "0o-de-lally", repo: "coco", assignedUser: "0o-de-lally" },
    ]);
    expect(deps.log).toHaveBeenCalledWith(
      "✓ GitHub App installed (all repositories)",
    );
  });

  it("clears stale config repos and waits when app is fully uninstalled, then syncs on install", async () => {
    // First call: no installations (app was removed out-of-band).
    // Second call (poll): app reinstalled with repos.
    let callCount = 0;
    server.use(
      http.get(`${BASE}/user/installations`, () => {
        callCount++;
        return HttpResponse.json(
          callCount === 1 ? installationsEmpty : installationsPersonalSelected,
        );
      }),
      http.get(`${BASE}/user/installations/${INSTALLATION_ID}/repositories`, () =>
        HttpResponse.json(installationRepos),
      ),
    );

    const config: Config = {
      users: [{ handle: "0o-de-lally", token: TOKEN }],
      repositories: [
        // stale entry that should be removed once we discover app is uninstalled
        { owner: "0o-de-lally", repo: "stale-repo", assignedUser: "0o-de-lally" },
      ],
    };
    const deps = makeDeps(config, {
      resolveRepo: vi.fn().mockResolvedValue({ owner: "0o-de-lally", repo: "coco" }),
    });

    await runGithubAdd(undefined, deps);

    // stale-repo gone; all repos from reinstalled fixture present
    expect(config.repositories.find((r) => r.repo === "stale-repo")).toBeUndefined();
    expect(config.repositories.map((r) => r.repo).sort()).toEqual([
      "ai-notes",
      "app",
      "atomica",
      "coco",
    ]);
    expect(deps.log).toHaveBeenCalledWith("Waiting for installation...");
    expect(deps.log).toHaveBeenCalledWith("✓ App installed");
  }, 15_000);

  it("clears stale config repos and waits when target repo missing, then syncs on access", async () => {
    // The bug scenario: app installed on other repos (not target), user
    // previously had a different repo in config that's now gone.
    // Poll detects when the target repo is granted access.
    const reposWithoutTarget = {
      total_count: 1,
      repositories: [{ id: 16011412, full_name: "0o-de-lally/app", private: true }],
    };
    const reposWithTarget = {
      total_count: 2,
      repositories: [
        { id: 16011412, full_name: "0o-de-lally/app", private: true },
        { id: 1018648684, full_name: "0o-de-lally/coco", private: true },
      ],
    };

    let repoCallCount = 0;
    server.use(
      http.get(`${BASE}/user/installations`, () =>
        HttpResponse.json(installationsPersonalSelected),
      ),
      http.get(`${BASE}/user/installations/${INSTALLATION_ID}/repositories`, () => {
        repoCallCount++;
        return HttpResponse.json(
          repoCallCount <= 2 ? reposWithoutTarget : reposWithTarget,
        );
      }),
    );

    const config: Config = {
      users: [{ handle: "0o-de-lally", token: TOKEN }],
      repositories: [
        // stale: was in config but app no longer installed on it
        { owner: "0o-de-lally", repo: "stale-repo", assignedUser: "0o-de-lally" },
      ],
    };
    const deps = makeDeps(config, {
      resolveRepo: vi.fn().mockResolvedValue({ owner: "0o-de-lally", repo: "coco" }),
    });

    await runGithubAdd(undefined, deps);

    // stale-repo gone; both accessible repos synced
    expect(config.repositories.find((r) => r.repo === "stale-repo")).toBeUndefined();
    expect(config.repositories.map((r) => r.repo).sort()).toEqual(["app", "coco"]);
    expect(deps.log).toHaveBeenCalledWith("Waiting for access...");
  }, 15_000);
});
