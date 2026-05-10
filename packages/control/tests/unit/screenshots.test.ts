/**
 * Unit tests for packages/control/src/screenshots.ts
 *
 * Tests the GET /studio/screenshots/:sessionId and
 * GET /studio/screenshots/diff/:sessionId/:beforeTurn/:afterTurn route handlers.
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
    const [first, second, third] = body.screenshots;
    expect(first?.turnIndex).toBe(1);
    expect(second?.turnIndex).toBe(2);
    expect(third?.turnIndex).toBe(3);
    expect(first?.url).toContain("/studio/screenshots/");
    expect(first?.filename).toBe("turn-1.png");
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

describe("handleScreenshotsRequest — diff endpoint", () => {
  it("returns diff metadata with both files existing", async () => {
    seedSession("diff-sess", [1, 2]);
    const res = handleScreenshotsRequest(
      makeReq("/studio/screenshots/diff/diff-sess/1/2"),
      makeUrl("/studio/screenshots/diff/diff-sess/1/2"),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as {
      sessionId: string;
      beforeTurn: number;
      afterTurn: number;
      beforeUrl: string;
      afterUrl: string;
      beforeExists: boolean;
      afterExists: boolean;
    };
    expect(body.sessionId).toBe("diff-sess");
    expect(body.beforeTurn).toBe(1);
    expect(body.afterTurn).toBe(2);
    expect(body.beforeExists).toBe(true);
    expect(body.afterExists).toBe(true);
    expect(body.beforeUrl).toContain("turn-1.png");
    expect(body.afterUrl).toContain("turn-2.png");
  });

  it("returns beforeExists=false when before screenshot is missing", async () => {
    seedSession("diff-partial", [2]);
    const res = handleScreenshotsRequest(
      makeReq("/studio/screenshots/diff/diff-partial/1/2"),
      makeUrl("/studio/screenshots/diff/diff-partial/1/2"),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as {
      beforeExists: boolean;
      afterExists: boolean;
    };
    expect(body.beforeExists).toBe(false);
    expect(body.afterExists).toBe(true);
  });

  it("returns both false when session does not exist", async () => {
    const res = handleScreenshotsRequest(
      makeReq("/studio/screenshots/diff/no-session/1/2"),
      makeUrl("/studio/screenshots/diff/no-session/1/2"),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as {
      beforeExists: boolean;
      afterExists: boolean;
    };
    expect(body.beforeExists).toBe(false);
    expect(body.afterExists).toBe(false);
  });

  it("returns null for non-numeric turn indices (no pattern match)", async () => {
    // Path /studio/screenshots/diff/sess/abc/def does not match the diff route
    // (\d+ required), does not match the single-file route (turn-N.png required),
    // and does not match the list route (has extra segments).
    // The handler returns null so the router can fall through.
    const res = handleScreenshotsRequest(
      makeReq("/studio/screenshots/diff/sess/abc/def"),
      makeUrl("/studio/screenshots/diff/sess/abc/def"),
    );
    expect(res).toBeNull();
  });
});
