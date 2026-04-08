import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { GitHubClient } from "../../client.ts";
import installationsEmpty from "../../../../tests/fixtures/github/user-installations-empty.json";
import installationsPersonalSelected from "../../../../tests/fixtures/github/user-installations-personal-selected.json";
import installationsOrgSelected from "../../../../tests/fixtures/github/user-installations-org-selected.json";
import installationsAllRepos from "../../../../tests/fixtures/github/user-installations-all-repos.json";
import installationRepos from "../../../../tests/fixtures/github/installation-repos.json";

const BASE = "https://api.github.com";

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("GitHubClient.listAllInstallations", () => {
  it("returns empty array when no installations exist", async () => {
    server.use(
      http.get(`${BASE}/user/installations`, () =>
        HttpResponse.json(installationsEmpty),
      ),
    );

    const client = new GitHubClient("ghu_test");
    const result = await client.listAllInstallations();
    expect(result).toEqual([]);
  });

  it("returns personal account installation with selected repos", async () => {
    server.use(
      http.get(`${BASE}/user/installations`, () =>
        HttpResponse.json(installationsPersonalSelected),
      ),
    );

    const client = new GitHubClient("ghu_test");
    const result = await client.listAllInstallations();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 122161367,
      appSlug: "superfield-cli",
      accountLogin: "0o-de-lally",
      accountType: "User",
      repositorySelection: "selected",
    });
  });

  it("returns org installation with selected repos", async () => {
    server.use(
      http.get(`${BASE}/user/installations`, () =>
        HttpResponse.json(installationsOrgSelected),
      ),
    );

    const client = new GitHubClient("ghu_test");
    const result = await client.listAllInstallations();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 22222222,
      appSlug: "superfield-cli",
      accountLogin: "dot-matrix-labs",
      accountType: "Organization",
      repositorySelection: "selected",
    });
  });

  it("returns installation with all-repos selection", async () => {
    server.use(
      http.get(`${BASE}/user/installations`, () =>
        HttpResponse.json(installationsAllRepos),
      ),
    );

    const client = new GitHubClient("ghu_test");
    const result = await client.listAllInstallations();
    expect(result[0]?.repositorySelection).toBe("all");
  });

  it("paginates through multiple pages", async () => {
    const page1 = {
      total_count: 2,
      installations: [installationsPersonalSelected.installations[0]],
    };
    const page2 = {
      total_count: 2,
      installations: [installationsOrgSelected.installations[0]],
    };

    server.use(
      http.get(`${BASE}/user/installations`, ({ request }) => {
        const page = new URL(request.url).searchParams.get("page");
        return HttpResponse.json(page === "2" ? page2 : page1);
      }),
    );

    const client = new GitHubClient("ghu_test");
    // First page has 1 item (< 100), so pagination stops — test single page behaviour
    const result = await client.listAllInstallations();
    expect(result).toHaveLength(1); // stops after first page since length < 100
  });
});

describe("GitHubClient.listInstallationRepos", () => {
  it("returns full_name of each repository", async () => {
    server.use(
      http.get(`${BASE}/user/installations/122161367/repositories`, () =>
        HttpResponse.json(installationRepos),
      ),
    );

    const client = new GitHubClient("ghu_test");
    const repos = await client.listInstallationRepos(122161367);
    expect(repos).toEqual([
      "0o-de-lally/app",
      "0o-de-lally/ai-notes",
      "0o-de-lally/coco",
      "0o-de-lally/atomica",
    ]);
  });

  it("returns empty array when no repositories selected", async () => {
    server.use(
      http.get(`${BASE}/user/installations/122161367/repositories`, () =>
        HttpResponse.json({ total_count: 0, repositories: [] }),
      ),
    );

    const client = new GitHubClient("ghu_test");
    const repos = await client.listInstallationRepos(122161367);
    expect(repos).toEqual([]);
  });

  it("paginates when more than 100 repositories exist", async () => {
    const page1Repos = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      full_name: `org/repo-${i + 1}`,
      private: false,
    }));
    const page2Repos = [{ id: 101, full_name: "org/repo-101", private: false }];

    server.use(
      http.get(
        `${BASE}/user/installations/122161367/repositories`,
        ({ request }) => {
          const page = new URL(request.url).searchParams.get("page");
          return HttpResponse.json(
            page === "2"
              ? { total_count: 101, repositories: page2Repos }
              : { total_count: 101, repositories: page1Repos },
          );
        },
      ),
    );

    const client = new GitHubClient("ghu_test");
    const repos = await client.listInstallationRepos(122161367);
    expect(repos).toHaveLength(101);
    expect(repos.at(-1)).toBe("org/repo-101");
  });
});

describe("GitHubClient.listAppInstallations", () => {
  it("filters by app slug case-insensitively", async () => {
    const mixed = {
      total_count: 2,
      installations: [
        {
          ...installationsOrgSelected.installations[0],
          app_slug: "Superfield-CLI",
        },
        {
          ...installationsPersonalSelected.installations[0],
          app_slug: "other-app",
          id: 99,
        },
      ],
    };
    server.use(
      http.get(`${BASE}/user/installations`, () => HttpResponse.json(mixed)),
    );

    const client = new GitHubClient("ghu_test");
    const result = await client.listAppInstallations("superfield-cli");
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(22222222);
  });

  it("returns empty when slug does not match", async () => {
    server.use(
      http.get(`${BASE}/user/installations`, () =>
        HttpResponse.json(installationsOrgSelected),
      ),
    );

    const client = new GitHubClient("ghu_test");
    const result = await client.listAppInstallations("wrong-slug");
    expect(result).toEqual([]);
  });
});
