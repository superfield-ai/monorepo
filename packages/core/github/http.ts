import type { GitHubHttpDeps } from "./types.ts";
import { SuperfieldError } from "../errors.ts";

export const GITHUB_API_BASE = "https://api.github.com";
export const GITHUB_API_VERSION = "2022-11-28";

export class GitHubApiError extends SuperfieldError {
  readonly status: number;
  readonly url: string;
  readonly githubMessage: string;
  readonly responseBody: string;

  constructor(opts: {
    status: number;
    url: string;
    githubMessage: string;
    responseBody: string;
  }) {
    super(
      "github_api",
      `GitHub API request failed (${opts.status}) for ${opts.url}: ${opts.githubMessage}`,
      {
        context: {
          status: opts.status,
          url: opts.url,
          githubMessage: opts.githubMessage,
        },
      },
    );
    this.status = opts.status;
    this.url = opts.url;
    this.githubMessage = opts.githubMessage;
    this.responseBody = opts.responseBody;
  }
}

export interface GithubRequestInit extends Omit<RequestInit, "body"> {
  jsonBody?: unknown;
}

export async function githubRequest<T>(
  path: string,
  init: GithubRequestInit = {},
  deps: GitHubHttpDeps,
): Promise<{ status: number; data: T | null; headers: Headers }> {
  const url = path.startsWith("http") ? path : `${GITHUB_API_BASE}${path}`;
  const token = await deps.getToken();

  const headers = new Headers(init.headers ?? {});
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Accept", "application/vnd.github+json");
  headers.set("X-GitHub-Api-Version", GITHUB_API_VERSION);

  let body: BodyInit | undefined;
  if (init.jsonBody !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.jsonBody);
  }

  const response = await deps.fetch(url, {
    ...init,
    headers,
    body,
  });

  const text = await response.text();
  let data: T | null = null;
  if (text) {
    try {
      data = JSON.parse(text) as T;
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const message =
      (data && typeof data === "object" && "message" in data
        ? String((data as { message: unknown }).message)
        : null) ?? response.statusText;
    throw new GitHubApiError({
      status: response.status,
      url,
      githubMessage: message,
      responseBody: text,
    });
  }

  return { status: response.status, data, headers: response.headers };
}
