import { describe, it, expect, vi, afterEach } from "vitest";
import { featureCommand } from "../../commands/feature.ts";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  runFeatureCommand: vi.fn(),
  readRemoteOwnerRepo: vi.fn(),
  GitHubClient: vi.fn(),
  GitClient: vi.fn(),
}));

vi.mock("@superfield/core", () => ({
  loadConfig: mocks.loadConfig,
  runFeatureCommand: mocks.runFeatureCommand,
}));

vi.mock("@superfield/git", () => ({
  GitClient: mocks.GitClient.mockImplementation(function thisGitClient() {
    return {
      readRemoteOwnerRepo: mocks.readRemoteOwnerRepo,
    };
  }),
}));

vi.mock("@superfield/github", () => ({
  GitHubClient: mocks.GitHubClient.mockImplementation(
    function thisGitHubClient() {
      return {};
    },
  ),
}));

afterEach(() => {
  vi.restoreAllMocks();
  mocks.loadConfig.mockReset();
  mocks.runFeatureCommand.mockReset();
  mocks.readRemoteOwnerRepo.mockReset();
  mocks.GitHubClient.mockClear();
  mocks.GitClient.mockClear();
});

describe("featureCommand", () => {
  it("prints a duplicate warning when the core command reports one", async () => {
    mocks.loadConfig.mockResolvedValue({
      users: [{ handle: "octocat", token: "ghp_test" }],
      repositories: [],
    });
    mocks.readRemoteOwnerRepo.mockResolvedValue({
      owner: "org",
      repo: "repo",
    });
    mocks.runFeatureCommand.mockResolvedValue({
      duplicateOf: 42,
      issueCreated: null,
      planUpdated: false,
      planCreated: false,
      blueprintRulesCited: [],
    });

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await featureCommand("add a login button", "/tmp/repo");

    expect(mocks.readRemoteOwnerRepo).toHaveBeenCalledWith("/tmp/repo");
    expect(mocks.runFeatureCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "org",
        repo: "repo",
        request: "add a login button",
        cwd: "/tmp/repo",
      }),
    );
    expect(log).toHaveBeenCalledWith(
      "Evaluating feature request for org/repo\n",
    );
    expect(log).toHaveBeenCalledWith("Request: add a login button\n");
    expect(log).toHaveBeenCalledWith(
      "✗ Duplicate of #42 — no new issue created.",
    );
    expect(error).not.toHaveBeenCalled();
  });
});
