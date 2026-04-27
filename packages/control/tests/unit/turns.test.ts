import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { handleTurnsRequest } from "../../src/turns";

let originalLogDir: string | undefined;
let originalRepoRoot: string | undefined;
let workdir: string;

beforeEach(() => {
  originalLogDir = process.env.CONTROL_LOG_DIR;
  originalRepoRoot = process.env.SUPERFIELD_REPO_ROOT;
  workdir = mkdtempSync(join(tmpdir(), "turns-test-"));
  process.env.CONTROL_LOG_DIR = workdir;
});

afterEach(() => {
  if (originalLogDir === undefined) delete process.env.CONTROL_LOG_DIR;
  else process.env.CONTROL_LOG_DIR = originalLogDir;
  if (originalRepoRoot === undefined) delete process.env.SUPERFIELD_REPO_ROOT;
  else process.env.SUPERFIELD_REPO_ROOT = originalRepoRoot;
  rmSync(workdir, { recursive: true, force: true });
});

function makeReq(pathname: string): Request {
  return new Request(`http://localhost${pathname}`);
}
function makeUrl(pathname: string): URL {
  return new URL(`http://localhost${pathname}`);
}

describe("handleTurnsRequest", () => {
  it("returns null for non-matching path", () => {
    const res = handleTurnsRequest(
      makeReq("/studio/other"),
      makeUrl("/studio/other"),
    );
    expect(res).toBeNull();
  });

  it("returns empty turns when log dir is empty", async () => {
    const res = handleTurnsRequest(
      makeReq("/studio/turns/abc"),
      makeUrl("/studio/turns/abc"),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { sessionId: string; turns: unknown[] };
    expect(body.sessionId).toBe("abc");
    expect(body.turns).toEqual([]);
  });

  it("filters turns by sessionId across multiple jsonl files", async () => {
    const path1 = join(workdir, "2026-04-26.jsonl");
    const path2 = join(workdir, "2026-04-25.jsonl");
    writeFileSync(
      path1,
      [
        JSON.stringify({
          timestamp: "2026-04-26T01:00:00Z",
          message: "p1",
          response: "r1",
          sessionId: "s-a",
        }),
        JSON.stringify({
          timestamp: "2026-04-26T02:00:00Z",
          message: "p2",
          response: "r2",
          sessionId: "s-b",
        }),
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      path2,
      JSON.stringify({
        timestamp: "2026-04-25T05:00:00Z",
        message: "p0",
        response: "r0",
        sessionId: "s-a",
      }) + "\n",
      "utf8",
    );

    const res = handleTurnsRequest(
      makeReq("/studio/turns/s-a"),
      makeUrl("/studio/turns/s-a"),
    );
    const body = (await res!.json()) as {
      sessionId: string;
      turns: { ts: string; prompt: string }[];
    };
    expect(body.turns).toHaveLength(2);
    // Ascending by ts
    expect(body.turns[0]!.prompt).toBe("p0");
    expect(body.turns[1]!.prompt).toBe("p1");
  });

  it("ignores malformed JSONL lines", async () => {
    writeFileSync(
      join(workdir, "log.jsonl"),
      ["{not json}", JSON.stringify({ message: "p", sessionId: "x" })].join(
        "\n",
      ),
      "utf8",
    );
    const res = handleTurnsRequest(
      makeReq("/studio/turns/x"),
      makeUrl("/studio/turns/x"),
    );
    const body = (await res!.json()) as { turns: unknown[] };
    expect(body.turns).toHaveLength(1);
  });
});
