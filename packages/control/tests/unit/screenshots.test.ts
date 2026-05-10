/**
 * Unit tests for packages/control/src/screenshots.ts
 *
 * Tests the GET /studio/screenshots/:sessionId route handler.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { handleScreenshotsRequest } from "../../src/screenshots";

let workdir: string;
let originalRepoRoot: string | undefined;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "screenshots-route-test-"));
  originalRepoRoot = process.env.SUPERFIELD_REPO_ROOT;
  process.env.SUPERFIELD_REPO_ROOT = workdir;
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
  if (originalRepoRoot === undefined) delete process.env.SUPERFIELD_REPO_ROOT;
  else process.env.SUPERFIELD_REPO_ROOT = originalRepoRoot;
});

function makeReq(pathname: string): Request {
  return new Request(`http://localhost${pathname}`);
}
function makeUrl(pathname: string): URL {
  return new URL(`http://localhost${pathname}`);
}

/** Create a session directory with dummy PNG files. */
function seedSession(sessionId: string, turns: number[]): void {
  const dir = join(workdir, "docs", "studio-sessions", sessionId);
  mkdirSync(dir, { recursive: true });
  for (const n of turns) {
    writeFileSync(join(dir, `turn-${n}.png`), Buffer.from(`PNG${n}`));
  }
}

describe("handleScreenshotsRequest", () => {
  it("returns null for non-matching path", () => {
    const res = handleScreenshotsRequest(
      makeReq("/studio/other"),
      makeUrl("/studio/other"),
    );
    expect(res).toBeNull();
  });

  it("returns null for POST requests", () => {
    const req = new Request("http://localhost/studio/screenshots/abc", {
      method: "POST",
    });
    const res = handleScreenshotsRequest(
      req,
      makeUrl("/studio/screenshots/abc"),
    );
    expect(res).toBeNull();
  });

  it("returns empty list when session dir does not exist", async () => {
    const res = handleScreenshotsRequest(
      makeReq("/studio/screenshots/missing-session"),
      makeUrl("/studio/screenshots/missing-session"),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as {
      sessionId: string;
      screenshots: unknown[];
    };
    expect(body.sessionId).toBe("missing-session");
    expect(body.screenshots).toEqual([]);
  });

  it("returns sorted screenshot list for existing session", async () => {
    seedSession("test-sess", [3, 1, 2]);
    const res = handleScreenshotsRequest(
      makeReq("/studio/screenshots/test-sess"),
      makeUrl("/studio/screenshots/test-sess"),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as {
      sessionId: string;
      screenshots: Array<{ filename: string; turnIndex: number; url: string }>;
    };
    expect(body.sessionId).toBe("test-sess");
    expect(body.screenshots).toHaveLength(3);
    expect(body.screenshots[0].turnIndex).toBe(1);
    expect(body.screenshots[1].turnIndex).toBe(2);
    expect(body.screenshots[2].turnIndex).toBe(3);
    expect(body.screenshots[0].url).toContain("/studio/screenshots/");
    expect(body.screenshots[0].filename).toBe("turn-1.png");
  });

  it("serves a PNG file at /studio/screenshots/:sessionId/:filename", async () => {
    seedSession("png-sess", [1]);
    const res = handleScreenshotsRequest(
      makeReq("/studio/screenshots/png-sess/turn-1.png"),
      makeUrl("/studio/screenshots/png-sess/turn-1.png"),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get("Content-Type")).toBe("image/png");
  });

  it("returns 404 for a filename that doesn't match turn-N.png", async () => {
    seedSession("bad-sess", [1]);
    // Non-PNG filename should be rejected
    const res = handleScreenshotsRequest(
      makeReq("/studio/screenshots/bad-sess/secrets.json"),
      makeUrl("/studio/screenshots/bad-sess/secrets.json"),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
  });

  it("returns 404 for a missing PNG file", async () => {
    // Session exists but turn-99 does not
    seedSession("sparse-sess", [1]);
    const res = handleScreenshotsRequest(
      makeReq("/studio/screenshots/sparse-sess/turn-99.png"),
      makeUrl("/studio/screenshots/sparse-sess/turn-99.png"),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
  });
});
