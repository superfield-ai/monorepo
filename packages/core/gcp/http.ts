import { createHash } from "node:crypto";
import type { AuthDeps } from "./types.ts";

export interface HttpDeps {
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  getAccessToken: () => Promise<string>;
  fixtureDir?: string;
  readFile?: (filePath: string) => string;
  writeFile?: (filePath: string, contents: string) => void;
}

export function makeDefaultHttpDeps(authDeps: AuthDeps & { getAccessToken: () => Promise<string> }): HttpDeps {
  return {
    fetch: authDeps.fetch,
    getAccessToken: authDeps.getAccessToken,
  };
}

function fixtureKey(method: string, url: string, body?: string): string {
  const input = `${method}:${url}:${body ?? ""}`;
  return createHash("sha256").update(input).digest("hex");
}

export async function googleJsonRequest<T>(
  url: string,
  init: RequestInit = {},
  deps: HttpDeps,
): Promise<T | null> {
  const accessToken = await deps.getAccessToken();

  const method = init.method ?? "GET";
  const bodyStr =
    init.body !== undefined && init.body !== null && typeof init.body === "string"
      ? init.body
      : undefined;

  // Record/replay
  if (deps.fixtureDir) {
    const key = fixtureKey(method, url, bodyStr);
    const fixturePath = `${deps.fixtureDir}/${key}.json`;

    if (deps.readFile) {
      try {
        const content = deps.readFile(fixturePath);
        const parsed = JSON.parse(content) as { status: number; body: T | null };
        if (parsed.status < 200 || parsed.status >= 300) {
          throw new Error(
            `Google API request failed (${parsed.status}): (replayed)`,
          );
        }
        return parsed.body;
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith("Google API request failed")
        ) {
          throw error;
        }
        // File not found or parse error — fall through to live request
      }
    }

    // Live request and record
    const headers = new Headers(init.headers ?? {});
    headers.set("Authorization", `Bearer ${accessToken}`);
    if (bodyStr !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const response = await deps.fetch(url, { ...init, headers });
    const bodyText = await response.text();

    const fixture = { status: response.status, body: bodyText ? JSON.parse(bodyText) : null };
    if (deps.writeFile) {
      deps.writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
    }

    if (!response.ok) {
      throw new Error(
        `Google API request failed (${response.status} ${response.statusText}): ${bodyText}`,
      );
    }
    return fixture.body as T | null;
  }

  // Live request (no fixture)
  const headers = new Headers(init.headers ?? {});
  headers.set("Authorization", `Bearer ${accessToken}`);
  if (bodyStr !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await deps.fetch(url, { ...init, headers });
  const bodyText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Google API request failed (${response.status} ${response.statusText}): ${bodyText}`,
    );
  }

  if (!bodyText) {
    return null;
  }

  return JSON.parse(bodyText) as T;
}
