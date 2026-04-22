import { spawn } from "node:child_process";

export interface GetAuthTokenDeps {
  spawnGhAuthToken?: () => Promise<{
    stdout: string;
    stderr: string;
    code: number;
  }>;
}

function defaultSpawnGhAuthToken(): Promise<{
  stdout: string;
  stderr: string;
  code: number;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", ["auth", "token"], { stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      reject(err);
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? 0 });
    });
  });
}

export async function getAuthToken(
  deps: GetAuthTokenDeps = {},
): Promise<string> {
  const run = deps.spawnGhAuthToken ?? defaultSpawnGhAuthToken;
  let result;
  try {
    result = await run();
  } catch (error) {
    throw new Error(
      `Failed to invoke 'gh auth token': ${
        error instanceof Error ? error.message : String(error)
      }. Is the GitHub CLI installed?`,
      { cause: error },
    );
  }

  if (result.code !== 0) {
    throw new Error(
      `'gh auth token' exited with code ${result.code}: ${
        result.stderr.trim() || result.stdout.trim() || "no output"
      }. Run 'gh auth login' first.`,
    );
  }

  const token = result.stdout.trim();
  if (!token) {
    throw new Error(
      `'gh auth token' returned an empty token. Run 'gh auth login' first.`,
    );
  }
  return token;
}
