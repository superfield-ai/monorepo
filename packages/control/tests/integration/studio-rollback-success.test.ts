import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type ChildProcess, spawn, spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { startPostgres, type PgContainer } from "../helpers/pg-container";

const REPO_ROOT = new URL("../../../../", import.meta.url).pathname;
const CLONE_ROOT = join("/tmp", `superfield-studio-rollback-${Date.now()}`);
const PORT = 31418;
const BASE = `http://localhost:${PORT}`;
const SERVER_READY_TIMEOUT_MS = 60_000;
const SERVER_ENTRY = join(REPO_ROOT, "apps/server/src/index.ts");

// Skip when apps/server/src/index.ts is absent (cli monorepo, not template).
describe.skipIf(!existsSync(SERVER_ENTRY))(
  "studio-rollback-success suite",
  () => {
    const BRANCH = "studio/session-test-rollback-a1b2";
    const SESSION_ID = "a1b2";
    const SOURCE_BRANCH = currentBranch(REPO_ROOT);

    let pg: PgContainer;
    let server: ChildProcess | null = null;
    let authCookie = "";

    beforeEach(async () => {
      const clone = spawnSync("git", ["clone", REPO_ROOT, CLONE_ROOT], {
        cwd: REPO_ROOT,
        stdio: "pipe",
      });
      expect(clone.status).toBe(0);

      spawnSync("git", ["config", "user.name", "Studio Test"], {
        cwd: CLONE_ROOT,
        stdio: "pipe",
      });
      spawnSync("git", ["config", "user.email", "studio-test@example.com"], {
        cwd: CLONE_ROOT,
        stdio: "pipe",
      });
      spawnSync("git", ["branch", "-f", "main", "HEAD"], {
        cwd: CLONE_ROOT,
        stdio: "pipe",
      });
      spawnSync("git", ["checkout", "-b", BRANCH], {
        cwd: CLONE_ROOT,
        stdio: "pipe",
      });

      const sessionDir = join(CLONE_ROOT, "docs", "studio-sessions", BRANCH);
      mkdirSync(sessionDir, { recursive: true });
      const changesPath = join(sessionDir, "changes.md");
      writeFileSync(
        changesPath,
        `# Studio Session — ${BRANCH}
**Started:** ${new Date().toISOString()}

## Changes

### Turn 1 — Bootstrap
Initial studio session.
`,
      );

      writeFileSync(
        join(CLONE_ROOT, ".studio"),
        JSON.stringify(
          {
            sessionId: SESSION_ID,
            branch: BRANCH,
            startedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );

      spawnSync(
        "git",
        [
          "add",
          ".studio",
          join("docs", "studio-sessions", BRANCH, "changes.md"),
        ],
        {
          cwd: CLONE_ROOT,
          stdio: "pipe",
        },
      );
      spawnSync(
        "git",
        ["commit", "--no-verify", "-m", `studio: start session ${SESSION_ID}`],
        {
          cwd: CLONE_ROOT,
          stdio: "pipe",
        },
      );

      writeFileSync(
        changesPath,
        `${readFileSync(changesPath, "utf8")}
### Turn 2 — Change
Added a rollback target change.
`,
      );
      spawnSync(
        "git",
        ["add", join("docs", "studio-sessions", BRANCH, "changes.md")],
        {
          cwd: CLONE_ROOT,
          stdio: "pipe",
        },
      );
      spawnSync(
        "git",
        ["commit", "--no-verify", "-m", "studio: apply rollback target change"],
        {
          cwd: CLONE_ROOT,
          stdio: "pipe",
        },
      );

      // Reuse a pre-existing DATABASE_URL (e.g. CI service container) if available
      let databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl) {
        pg = await startPostgres();
        databaseUrl = pg.url;
      }
      server = spawn("bun", ["run", SERVER_ENTRY], {
        cwd: CLONE_ROOT,
        env: {
          ...process.env,
          SUPERFIELD_REPO_ROOT: CLONE_ROOT,
          DATABASE_URL: databaseUrl,
          CONTROL_PORT: String(PORT),
        },
        stdio: ["ignore", "ignore", "pipe"],
      });

      const stderrChunks: Buffer[] = [];
      server.stderr!.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      await waitForServer(server, stderrChunks);

      // Register a test user and capture the session cookie for auth-gated studio routes
      const username = `rollback_test_${Date.now()}`;
      const registerRes = await fetch(`${BASE}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password: "testpass123" }),
      });
      const setCookies = registerRes.headers.getSetCookie
        ? registerRes.headers.getSetCookie()
        : [registerRes.headers.get("set-cookie") ?? ""];
      const cookiePairs: string[] = [];
      for (const raw of setCookies) {
        const pair = raw.split(";")[0]!.trim();
        if (pair) cookiePairs.push(pair);
      }
      authCookie = cookiePairs.join("; ");
    }, 120_000);

    afterEach(async () => {
      server?.kill();
      server = null;
      await pg?.stop();
      rmSync(CLONE_ROOT, { recursive: true, force: true });
    });

    test("POST /studio/rollback resets the isolated branch to the requested commit and refreshes commits", async () => {
      const statusRes = await fetch(`${BASE}/studio/status`, {
        headers: { Cookie: authCookie },
      });
      const statusBody = await statusRes.json();
      expect(statusRes.status).toBe(200);
      expect(statusBody.active).toBe(true);
      expect(statusBody.commits).toHaveLength(2);

      const bootstrapCommit = statusBody.commits.find(
        (commit: { message: string }) =>
          commit.message.includes(`studio: start session ${SESSION_ID}`),
      );
      expect(bootstrapCommit).toBeTruthy();

      const rollbackRes = await fetch(`${BASE}/studio/rollback`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: authCookie },
        body: JSON.stringify({ hash: bootstrapCommit.hash }),
      });
      const rollbackBody = await rollbackRes.json();

      expect(rollbackRes.status).toBe(200);
      expect(rollbackBody.ok).toBe(true);
      expect(rollbackBody.commits).toHaveLength(1);
      expect(rollbackBody.commits[0].message).toContain(
        `studio: start session ${SESSION_ID}`,
      );

      const headCommit = spawnSync("git", ["log", "-1", "--pretty=%s"], {
        cwd: CLONE_ROOT,
        stdio: "pipe",
      });
      expect(headCommit.stdout.toString().trim()).toBe(
        `studio: start session ${SESSION_ID}`,
      );

      const changesContent = readFileSync(
        join(CLONE_ROOT, "docs", "studio-sessions", BRANCH, "changes.md"),
        "utf8",
      );
      expect(changesContent).not.toContain("Added a rollback target change.");
      expect(changesContent).toContain("Initial studio session.");
      expect(currentBranch(REPO_ROOT)).toBe(SOURCE_BRANCH);
    }, 90_000);

    async function waitForServer(
      proc: ChildProcess,
      stderrChunks: Buffer[],
    ): Promise<void> {
      const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        try {
          await fetch(`${BASE}/api/tasks`);
          return;
        } catch {
          await new Promise<void>((r) => setTimeout(r, 300));
        }
      }
      // Kill the process so the stderr stream reaches EOF, then read what was captured.
      proc.kill();
      let stderrOutput = "";
      try {
        await new Promise<void>((r) => proc.once("close", r));
        const stderrText = Buffer.concat(stderrChunks).toString();
        stderrOutput = stderrText ? `\nServer stderr:\n${stderrText}` : "";
      } catch {
        // ignore errors reading stderr
      }
      throw new Error(
        `Server at ${BASE} did not become ready within ${SERVER_READY_TIMEOUT_MS}ms${stderrOutput}`,
      );
    }

    function currentBranch(cwd: string) {
      const branch = spawnSync("git", ["branch", "--show-current"], {
        cwd,
        stdio: "pipe",
      });
      return branch.stdout.toString().trim();
    }
  },
); // end describe.skipIf
