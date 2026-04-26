import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type ChildProcess, spawn, spawnSync } from "child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { delimiter, join } from "path";
import { startPostgres, type PgContainer } from "../helpers/pg-container";

const PORT = 31419;
const BASE = `http://localhost:${PORT}`;
const SERVER_READY_TIMEOUT_MS = 60_000;
const REPO_ROOT = new URL("../../../../", import.meta.url).pathname;
const CLONE_ROOT = join("/tmp", `superfield-checkpoint-api-${Date.now()}`);
const SERVER_ENTRY = join(REPO_ROOT, "apps/server/src/index.ts");
const CLAUDE_STUB_DIR = join(REPO_ROOT, "tests", "fixtures");
const CLAUDE_LOG_PATH = join(
  CLONE_ROOT,
  "tests",
  "fixtures",
  "claude-integration.log",
);

const BRANCH = "studio/session-test-checkpoint-c1d2";
const SESSION_ID = "c1d2";

// This test requires apps/server/src/index.ts which only exists in the template
// repo. Skip the suite entirely when running in the cli monorepo.
describe.skipIf(!existsSync(SERVER_ENTRY))("checkpoint-api suite", () => {

let pg: PgContainer;
let server: ChildProcess;
let authCookie = "";

beforeAll(async () => {
  // Clone the repo into a temp directory
  const clone = spawnSync("git", ["clone", REPO_ROOT, CLONE_ROOT], {
    cwd: REPO_ROOT,
    stdio: "pipe",
  });
  expect(clone.status).toBe(0);

  spawnSync("git", ["config", "user.name", "Checkpoint API Test"], {
    cwd: CLONE_ROOT,
    stdio: "pipe",
  });
  spawnSync(
    "git",
    ["config", "user.email", "checkpoint-api-test@example.com"],
    {
      cwd: CLONE_ROOT,
      stdio: "pipe",
    },
  );
  spawnSync("git", ["branch", "-f", "main", "HEAD"], {
    cwd: CLONE_ROOT,
    stdio: "pipe",
  });
  spawnSync("git", ["checkout", "-b", BRANCH], {
    cwd: CLONE_ROOT,
    stdio: "pipe",
  });

  // Create the session directory and initial changes.md
  const sessionDir = join(CLONE_ROOT, "docs", "studio-sessions", BRANCH);
  mkdirSync(sessionDir, { recursive: true });
  const changesPath = join(sessionDir, "changes.md");
  writeFileSync(
    changesPath,
    `# Studio Session — ${BRANCH}
**Started:** ${new Date().toISOString()}

## Changes

`,
  );

  // Write the .studio file so the server sees studio mode as active
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

  // Commit the bootstrap files so they are not treated as uncommitted changes
  spawnSync(
    "git",
    ["add", ".studio", join("docs", "studio-sessions", BRANCH, "changes.md")],
    { cwd: CLONE_ROOT, stdio: "pipe" },
  );
  spawnSync(
    "git",
    ["commit", "--no-verify", "-m", `studio: start session ${SESSION_ID}`],
    {
      cwd: CLONE_ROOT,
      stdio: "pipe",
    },
  );

  // Create the log dir for the claude stub
  mkdirSync(join(CLONE_ROOT, "tests", "fixtures"), { recursive: true });

  // Start Postgres — reuse a pre-existing DATABASE_URL (e.g. CI service container) if available
  let databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    pg = await startPostgres();
    databaseUrl = pg.url;
  }

  // Start the server
  server = spawn("bun", ["run", SERVER_ENTRY], {
    cwd: CLONE_ROOT,
    env: {
      ...process.env,
      SUPERFIELD_REPO_ROOT: CLONE_ROOT,
      DATABASE_URL: databaseUrl,
      CONTROL_PORT: String(PORT),
      PATH: `${CLAUDE_STUB_DIR}${delimiter}${process.env.PATH ?? ""}`,
      CLAUDE_E2E_LOG_PATH: CLAUDE_LOG_PATH,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  const stderrChunks: Buffer[] = [];
  server.stderr!.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  await waitForServer(server, stderrChunks);

  // Register a test user and capture the session cookie
  const username = `checkpoint_api_test_${Date.now()}`;
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
    const pair = raw.split(";")[0].trim();
    if (pair) cookiePairs.push(pair);
  }
  authCookie = cookiePairs.join("; ");
}, 120_000);

afterAll(async () => {
  server?.kill();
  await pg?.stop();
  rmSync(CLAUDE_LOG_PATH, { force: true });
  rmSync(CLONE_ROOT, { recursive: true, force: true });
});

test("POST /studio/chat with a Design-mode message that produces file changes returns a timeline entry", async () => {
  // Write an uncommitted change so createCheckpointCommit has something to commit
  writeFileSync(
    join(CLONE_ROOT, "design-change.ts"),
    `// Design change produced by checkpoint API test\nexport const version = 1;\n`,
  );

  const chatRes = await fetch(`${BASE}/studio/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: authCookie },
    body: JSON.stringify({
      message: "Please update the header colour to blue.",
    }),
  });
  expect(chatRes.status).toBe(200);

  const chatBody = await chatRes.json();
  expect(Array.isArray(chatBody.timeline)).toBe(true);
  expect(chatBody.timeline.length).toBeGreaterThanOrEqual(1);

  const entry = chatBody.timeline[0];
  expect(typeof entry.hash).toBe("string");
  expect(entry.hash.length).toBeGreaterThan(0);
  expect(typeof entry.message).toBe("string");
  expect(entry.message.length).toBeGreaterThan(0);
  expect(typeof entry.timestamp).toBe("string");
  expect(new Date(entry.timestamp).toISOString()).toBeTruthy();
}, 60_000);

test("GET /studio/timeline returns the same checkpoint entry that chat produced", async () => {
  // Retrieve the timeline via the dedicated endpoint
  const timelineRes = await fetch(`${BASE}/studio/timeline`, {
    headers: { Cookie: authCookie },
  });
  expect(timelineRes.status).toBe(200);

  const timelineBody = await timelineRes.json();
  expect(Array.isArray(timelineBody.timeline)).toBe(true);
  expect(timelineBody.timeline.length).toBeGreaterThanOrEqual(1);

  const entry = timelineBody.timeline[0];
  expect(typeof entry.hash).toBe("string");
  expect(entry.hash.length).toBeGreaterThan(0);
  expect(typeof entry.message).toBe("string");
  expect(typeof entry.timestamp).toBe("string");
  expect(new Date(entry.timestamp).toISOString()).toBeTruthy();
}, 30_000);

test("POST /studio/rollback with a checkpoint hash removes it from GET /studio/timeline", async () => {
  // Confirm there is at least one timeline entry to roll back to
  const beforeRes = await fetch(`${BASE}/studio/timeline`, {
    headers: { Cookie: authCookie },
  });
  expect(beforeRes.status).toBe(200);
  const beforeBody = await beforeRes.json();
  expect(beforeBody.timeline.length).toBeGreaterThanOrEqual(1);

  // The first (oldest) entry is the checkpoint we want to roll back past
  const checkpointEntry = beforeBody.timeline[0];
  const checkpointHash = checkpointEntry.hash;

  // Create a second uncommitted change so there is something to roll back from
  writeFileSync(
    join(CLONE_ROOT, "second-change.ts"),
    `// Second change written before rollback\nexport const version = 2;\n`,
  );
  const chatRes = await fetch(`${BASE}/studio/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: authCookie },
    body: JSON.stringify({ message: "Increase the font size." }),
  });
  expect(chatRes.status).toBe(200);
  const chatBody = await chatRes.json();
  // Should now have at least 2 timeline entries
  expect(chatBody.timeline.length).toBeGreaterThanOrEqual(2);

  // Roll back to the first checkpoint hash
  const rollbackRes = await fetch(`${BASE}/studio/rollback`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: authCookie },
    body: JSON.stringify({ hash: checkpointHash }),
  });
  expect(rollbackRes.status).toBe(200);
  const rollbackBody = await rollbackRes.json();
  expect(rollbackBody.ok).toBe(true);

  // After rollback the second checkpoint should be gone
  const afterRes = await fetch(`${BASE}/studio/timeline`, {
    headers: { Cookie: authCookie },
  });
  expect(afterRes.status).toBe(200);
  const afterBody = await afterRes.json();
  // Timeline should now have exactly one entry (the one we rolled back to)
  expect(afterBody.timeline).toHaveLength(1);
  expect(afterBody.timeline[0].hash).toBe(checkpointHash);
}, 60_000);

}); // end describe.skipIf

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
