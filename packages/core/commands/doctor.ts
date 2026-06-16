import { execFile } from "node:child_process";

import { githubRequest } from "../github/http.ts";
import { getAuthToken } from "../github/auth.ts";
import type { GitHubHttpDeps } from "../github/types.ts";
import { deriveHmacToken, deriveEd25519Key } from "../secrets/index.ts";
import { SshClient } from "../ssh/client.ts";
import type { DeployBackend } from "./deploy.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  checks: CheckResult[];
  allOk: boolean;
}

// `DeployBackend` ("k3s" | "fastenv") is owned by ./deploy.ts and imported
// above so doctor and deploy share a single source of truth for the
// deployment-tier runtime selector. doctor defaults to "fastenv" — the engine
// Superfield now dogfoods (issue #660): the runtime check runs `fastenv doctor`
// over SSH and the db check runs `pg_isready` against the fastenv-run Postgres
// workload WITHOUT exec-ing into a Kubernetes pod. The "k3s" backend is the
// legacy coexistence path (`kubectl get nodes` / `kubectl exec`).

export interface DoctorOpts {
  repo: string;
  env: string;
  json?: boolean;
  /**
   * Deployment-tier runtime to verify. Defaults to `"fastenv"` — the engine
   * Superfield now dogfoods. Set to `"k3s"` during coexistence to verify the
   * legacy Kubernetes path instead.
   */
  backend?: DeployBackend;
  /**
   * BIP-39 mnemonic used to derive secrets for comparison. Required for the
   * `secret-fingerprints` and `ssh-reachable` checks. When omitted those
   * checks are skipped (marked as ok=false with an explanatory detail).
   */
  mnemonic?: Buffer;
}

// ---------------------------------------------------------------------------
// Deps interface (injected for tests)
// ---------------------------------------------------------------------------

export interface DoctorDeps {
  /** Run `gh auth status` and `gh auth token`. */
  spawnGh?: (
    args: string[],
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** HTTP HEAD against GHCR manifest URL. */
  fetchHead?: (url: string) => Promise<{ status: number }>;
  /** GitHub API deps for listing secrets. */
  githubDeps?: GitHubHttpDeps;
  /** Open an SSH connection and run a command. */
  sshExec?: (opts: {
    host: string;
    user: string;
    privateKeyPem: string;
    command: string;
    knownHostsPath: string;
  }) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

// ---------------------------------------------------------------------------
// Required secret names
// ---------------------------------------------------------------------------

const REQUIRED_SECRET_NAMES = (env: string): string[] => {
  const e = env.toUpperCase();
  return [
    `DEPLOY_HOST_${e}`,
    `DEPLOY_KEY_${e}`,
    `DATABASE_URL_${e}`,
    `WEBHOOK_SECRET_${e}`,
    `COOKIE_SECRET_${e}`,
  ];
};

/** Secrets that have a corresponding _FP fingerprint variable. */
const FINGERPRINTED_SECRETS = (
  env: string,
): Array<{ name: string; purpose: string; bytes: number }> => {
  const e = env.toUpperCase();
  return [
    { name: `WEBHOOK_SECRET_${e}`, purpose: "webhook-secret", bytes: 32 },
    { name: `COOKIE_SECRET_${e}`, purpose: "cookie-secret", bytes: 32 },
  ];
};

// ---------------------------------------------------------------------------
// Default dependency implementations
// ---------------------------------------------------------------------------

function defaultSpawnGh(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = execFile(
      "gh",
      args,
      { encoding: "utf8" },
      (err, stdout, stderr) => {
        const exitCode =
          err &&
          "code" in err &&
          typeof (err as NodeJS.ErrnoException).code === "number"
            ? ((err as NodeJS.ErrnoException & { code: number }).code as number)
            : err
              ? 1
              : 0;
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", exitCode });
      },
    );
    void child;
  });
}

async function defaultFetchHead(url: string): Promise<{ status: number }> {
  const response = await fetch(url, { method: "HEAD" });
  return { status: response.status };
}

function makeDefaultGithubDeps(): GitHubHttpDeps {
  let cached: string | null = null;
  return {
    fetch: globalThis.fetch,
    getToken: async () => {
      if (cached) return cached;
      cached = await getAuthToken();
      return cached;
    },
  };
}

async function defaultSshExec(opts: {
  host: string;
  user: string;
  privateKeyPem: string;
  command: string;
  knownHostsPath: string;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const client = new SshClient({
    host: opts.host,
    user: opts.user,
    privateKeyPem: opts.privateKeyPem,
    knownHostsPath: opts.knownHostsPath,
  });
  const result = await client.exec(opts.command);
  return result;
}

// ---------------------------------------------------------------------------
// Individual check implementations
// ---------------------------------------------------------------------------

async function checkGhAuth(deps: DoctorDeps): Promise<CheckResult> {
  const spawnGh = deps.spawnGh ?? defaultSpawnGh;
  try {
    const status = await spawnGh(["auth", "status"]);
    if (status.exitCode !== 0) {
      return {
        name: "gh-auth",
        ok: false,
        detail: `gh auth status failed (exit ${status.exitCode}): ${status.stderr.trim() || status.stdout.trim()}`,
      };
    }

    // Verify required scopes are present
    const tokenResult = await spawnGh(["auth", "token"]);
    if (tokenResult.exitCode !== 0 || !tokenResult.stdout.trim()) {
      return {
        name: "gh-auth",
        ok: false,
        detail: "gh auth token returned no token",
      };
    }

    const combined = status.stdout + status.stderr;
    const requiredScopes = ["repo", "read:org"];
    const missingScopes = requiredScopes.filter(
      (scope) => !combined.includes(scope),
    );

    if (missingScopes.length > 0) {
      return {
        name: "gh-auth",
        ok: false,
        detail: `Missing required scopes: ${missingScopes.join(", ")}`,
      };
    }

    return {
      name: "gh-auth",
      ok: true,
      detail: "Authenticated with required scopes",
    };
  } catch (err) {
    return {
      name: "gh-auth",
      ok: false,
      detail: `gh auth check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkGhcrPull(
  opts: DoctorOpts,
  deps: DoctorDeps,
): Promise<CheckResult> {
  const fetchHead = deps.fetchHead ?? defaultFetchHead;
  const [owner, repoName] = opts.repo.split("/");
  if (!owner || !repoName) {
    return {
      name: "ghcr-pull",
      ok: false,
      detail: `Invalid repo format: ${opts.repo}`,
    };
  }
  const url = `https://ghcr.io/v2/${owner}/${repoName}/manifests/latest`;
  try {
    const { status } = await fetchHead(url);
    if (status === 200 || status === 401) {
      // 401 means registry responded (auth required but reachable)
      return {
        name: "ghcr-pull",
        ok: true,
        detail: `GHCR manifest endpoint reachable (HTTP ${status})`,
      };
    }
    if (status === 404) {
      return {
        name: "ghcr-pull",
        ok: false,
        detail: `Image not found at ghcr.io/${owner}/${repoName} (HTTP 404)`,
      };
    }
    return {
      name: "ghcr-pull",
      ok: false,
      detail: `Unexpected HTTP ${status} from GHCR`,
    };
  } catch (err) {
    return {
      name: "ghcr-pull",
      ok: false,
      detail: `GHCR HEAD request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

interface ListSecretsResponse {
  secrets?: Array<{ name: string }>;
  total_count?: number;
}

async function checkSecretsPresent(
  opts: DoctorOpts,
  deps: DoctorDeps,
): Promise<CheckResult> {
  const githubDeps = deps.githubDeps ?? makeDefaultGithubDeps();
  const required = REQUIRED_SECRET_NAMES(opts.env);
  try {
    const { data } = await githubRequest<ListSecretsResponse>(
      `/repos/${opts.repo}/actions/secrets?per_page=100`,
      { method: "GET" },
      githubDeps,
    );
    const existing = new Set(
      (data?.secrets ?? []).map((s: { name: string }) => s.name),
    );
    const missing = required.filter((name) => !existing.has(name));
    if (missing.length > 0) {
      return {
        name: "secrets-present",
        ok: false,
        detail: `Missing secrets: ${missing.join(", ")}`,
      };
    }
    return {
      name: "secrets-present",
      ok: true,
      detail: `All ${required.length} required secrets present`,
    };
  } catch (err) {
    return {
      name: "secrets-present",
      ok: false,
      detail: `Failed to list secrets: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkSecretFingerprints(
  opts: DoctorOpts,
  deps: DoctorDeps,
): Promise<CheckResult> {
  if (!opts.mnemonic) {
    return {
      name: "secret-fingerprints",
      ok: false,
      detail: "No mnemonic provided — skipping fingerprint verification",
    };
  }
  const githubDeps = deps.githubDeps ?? makeDefaultGithubDeps();
  const targets = FINGERPRINTED_SECRETS(opts.env);
  const mismatched: string[] = [];

  for (const target of targets) {
    const fpVarName = `${target.name}_FP`;
    try {
      const { data } = await githubRequest<{ value?: string }>(
        `/repos/${opts.repo}/actions/variables/${encodeURIComponent(fpVarName)}`,
        { method: "GET" },
        githubDeps,
      );
      const recorded = data?.value;
      if (!recorded) {
        mismatched.push(`${fpVarName} not set`);
        continue;
      }

      // Derive fresh copy of the mnemonic for this check
      const mnemonicCopy = Buffer.from(opts.mnemonic);
      const derived = deriveHmacToken(
        mnemonicCopy,
        opts.env,
        target.purpose,
        target.bytes,
      );
      const { createHash } = await import("node:crypto");
      const expected = `sha256:${createHash("sha256").update(derived, "utf8").digest("hex")}`;

      if (recorded !== expected) {
        mismatched.push(`${target.name} fingerprint mismatch`);
      }
    } catch {
      mismatched.push(`${fpVarName} fetch failed`);
    }
  }

  if (mismatched.length > 0) {
    return {
      name: "secret-fingerprints",
      ok: false,
      detail: `Fingerprint issues: ${mismatched.join(", ")}`,
    };
  }
  return {
    name: "secret-fingerprints",
    ok: true,
    detail: "All secret fingerprints match derived values",
  };
}

async function getDeployHost(
  opts: DoctorOpts,
  githubDeps: GitHubHttpDeps,
): Promise<string | null> {
  const envUpper = opts.env.toUpperCase();
  try {
    // First try as a variable
    const { data } = await githubRequest<{ value?: string }>(
      `/repos/${opts.repo}/actions/variables/DEPLOY_HOST_${envUpper}`,
      { method: "GET" },
      githubDeps,
    );
    return data?.value ?? null;
  } catch {
    return null;
  }
}

async function checkSshReachable(
  opts: DoctorOpts,
  deps: DoctorDeps,
): Promise<CheckResult> {
  if (!opts.mnemonic) {
    return {
      name: "ssh-reachable",
      ok: false,
      detail: "No mnemonic provided — skipping SSH check",
    };
  }
  const githubDeps = deps.githubDeps ?? makeDefaultGithubDeps();
  const sshExec = deps.sshExec ?? defaultSshExec;

  const host = await getDeployHost(opts, githubDeps);
  if (!host) {
    return {
      name: "ssh-reachable",
      ok: false,
      detail: `DEPLOY_HOST_${opts.env.toUpperCase()} not set as a repo variable`,
    };
  }

  try {
    const mnemonicCopy = Buffer.from(opts.mnemonic);
    const { privateKeyPem } = deriveEd25519Key(
      mnemonicCopy,
      opts.env,
      "ssh-deploy-key",
    );
    const knownHostsPath = `${process.env["HOME"] ?? "/root"}/.ssh/known_hosts.superfield`;

    const result = await sshExec({
      host,
      user: "root",
      privateKeyPem,
      command: "echo ok",
      knownHostsPath,
    });

    if (result.exitCode === 0 && result.stdout.trim() === "ok") {
      return {
        name: "ssh-reachable",
        ok: true,
        detail: `SSH to ${host} succeeded`,
      };
    }
    return {
      name: "ssh-reachable",
      ok: false,
      detail: `SSH echo test failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
    };
  } catch (err) {
    return {
      name: "ssh-reachable",
      ok: false,
      detail: `SSH connection failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkFastenvRuntimeHealthy(
  opts: DoctorOpts,
  deps: DoctorDeps,
): Promise<CheckResult> {
  if (!opts.mnemonic) {
    return {
      name: "fastenv-runtime-healthy",
      ok: false,
      detail: "No mnemonic provided — skipping fastenv runtime check",
    };
  }
  const githubDeps = deps.githubDeps ?? makeDefaultGithubDeps();
  const sshExec = deps.sshExec ?? defaultSshExec;

  const host = await getDeployHost(opts, githubDeps);
  if (!host) {
    return {
      name: "fastenv-runtime-healthy",
      ok: false,
      detail: `DEPLOY_HOST_${opts.env.toUpperCase()} not set as a repo variable`,
    };
  }

  try {
    const mnemonicCopy = Buffer.from(opts.mnemonic);
    const { privateKeyPem } = deriveEd25519Key(
      mnemonicCopy,
      opts.env,
      "ssh-deploy-key",
    );
    const knownHostsPath = `${process.env["HOME"] ?? "/root"}/.ssh/known_hosts.superfield`;

    // `fastenv doctor` verifies the host container runtime is ready. No k3s,
    // no Kubernetes control plane, no kubectl.
    const result = await sshExec({
      host,
      user: "root",
      privateKeyPem,
      command: "fastenv doctor 2>&1",
      knownHostsPath,
    });

    if (result.exitCode !== 0) {
      return {
        name: "fastenv-runtime-healthy",
        ok: false,
        detail: `fastenv doctor failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim() || "(no output)"}`,
      };
    }

    return {
      name: "fastenv-runtime-healthy",
      ok: true,
      detail: `fastenv runtime healthy: ${result.stdout.trim().split("\n").pop() || "ok"}`,
    };
  } catch (err) {
    return {
      name: "fastenv-runtime-healthy",
      ok: false,
      detail: `fastenv runtime check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkK3sHealthy(
  opts: DoctorOpts,
  deps: DoctorDeps,
): Promise<CheckResult> {
  if (!opts.mnemonic) {
    return {
      name: "k3s-healthy",
      ok: false,
      detail: "No mnemonic provided — skipping k3s check",
    };
  }
  const githubDeps = deps.githubDeps ?? makeDefaultGithubDeps();
  const sshExec = deps.sshExec ?? defaultSshExec;

  const host = await getDeployHost(opts, githubDeps);
  if (!host) {
    return {
      name: "k3s-healthy",
      ok: false,
      detail: `DEPLOY_HOST_${opts.env.toUpperCase()} not set as a repo variable`,
    };
  }

  try {
    const mnemonicCopy = Buffer.from(opts.mnemonic);
    const { privateKeyPem } = deriveEd25519Key(
      mnemonicCopy,
      opts.env,
      "ssh-deploy-key",
    );
    const knownHostsPath = `${process.env["HOME"] ?? "/root"}/.ssh/known_hosts.superfield`;

    const result = await sshExec({
      host,
      user: "root",
      privateKeyPem,
      command: "kubectl get nodes --no-headers 2>/dev/null",
      knownHostsPath,
    });

    if (result.exitCode !== 0) {
      return {
        name: "k3s-healthy",
        ok: false,
        detail: `kubectl get nodes failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      };
    }

    const lines = result.stdout
      .trim()
      .split("\n")
      .filter((l) => l.trim());
    const readyNodes = lines.filter((l) => /\bReady\b/.test(l));

    if (readyNodes.length === 0) {
      return {
        name: "k3s-healthy",
        ok: false,
        detail: `No Ready nodes found. Output: ${result.stdout.trim() || "(empty)"}`,
      };
    }

    return {
      name: "k3s-healthy",
      ok: true,
      detail: `${readyNodes.length} Ready node(s)`,
    };
  } catch (err) {
    return {
      name: "k3s-healthy",
      ok: false,
      detail: `k3s check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkDbReachable(
  opts: DoctorOpts,
  deps: DoctorDeps,
): Promise<CheckResult> {
  if (!opts.mnemonic) {
    return {
      name: "db-reachable",
      ok: false,
      detail: "No mnemonic provided — skipping DB check",
    };
  }
  const githubDeps = deps.githubDeps ?? makeDefaultGithubDeps();
  const sshExec = deps.sshExec ?? defaultSshExec;

  const host = await getDeployHost(opts, githubDeps);
  if (!host) {
    return {
      name: "db-reachable",
      ok: false,
      detail: `DEPLOY_HOST_${opts.env.toUpperCase()} not set as a repo variable`,
    };
  }

  try {
    const mnemonicCopy = Buffer.from(opts.mnemonic);
    const { privateKeyPem } = deriveEd25519Key(
      mnemonicCopy,
      opts.env,
      "ssh-deploy-key",
    );
    const knownHostsPath = `${process.env["HOME"] ?? "/root"}/.ssh/known_hosts.superfield`;

    // Backend-aware DB reachability probe.
    //
    // fastenv (default, issue #660): run pg_isready inside the fastenv-run
    //   postgres workload via `fastenv exec`. This does NOT touch kubectl or a
    //   Kubernetes pod — it goes straight through the fastenv container engine.
    // k3s (legacy coexistence): find the postgres pod and `kubectl exec` into it.
    const backend = opts.backend ?? "fastenv";
    const command =
      backend === "k3s"
        ? "POD=$(kubectl get pod -l app=postgres -o jsonpath='{.items[0].metadata.name}' 2>/dev/null); " +
          '[ -n "$POD" ] && kubectl exec "$POD" -- pg_isready 2>&1 || echo \'no-postgres-pod\''
        : "fastenv exec superfield-postgres -- pg_isready 2>&1 || echo 'no-postgres-workload'";

    const result = await sshExec({
      host,
      user: "root",
      privateKeyPem,
      command,
      knownHostsPath,
    });

    if (result.exitCode !== 0) {
      return {
        name: "db-reachable",
        ok: false,
        detail: `DB check command failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      };
    }

    const out = result.stdout.trim();
    if (
      out.includes("no-postgres-pod") ||
      out.includes("no-postgres-workload")
    ) {
      return {
        name: "db-reachable",
        ok: false,
        detail:
          backend === "k3s"
            ? "No postgres pod found in cluster"
            : "No postgres workload found in fastenv runtime",
      };
    }
    if (out.includes("accepting connections")) {
      return {
        name: "db-reachable",
        ok: true,
        detail: "PostgreSQL is accepting connections",
      };
    }

    return {
      name: "db-reachable",
      ok: false,
      detail: `pg_isready output unexpected: ${out}`,
    };
  } catch (err) {
    return {
      name: "db-reachable",
      ok: false,
      detail: `DB reachability check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Main doctor function
// ---------------------------------------------------------------------------

/**
 * Run all preflight checks for the given environment and return a report.
 * Each check is independent — a failure in one does not prevent others from running.
 */
export async function doctor(
  opts: DoctorOpts,
  deps: DoctorDeps = {},
): Promise<DoctorReport> {
  // The deployment-tier runtime check is backend-aware. fastenv (the default,
  // dogfooded path) verifies the fastenv container engine; k3s is the legacy
  // coexistence path. Only one runtime check runs per report.
  const backend = opts.backend ?? "fastenv";
  const runtimeCheck =
    backend === "k3s"
      ? checkK3sHealthy(opts, deps)
      : checkFastenvRuntimeHealthy(opts, deps);

  const checks = await Promise.all([
    checkGhAuth(deps),
    checkGhcrPull(opts, deps),
    checkSecretsPresent(opts, deps),
    checkSecretFingerprints(opts, deps),
    checkSshReachable(opts, deps),
    runtimeCheck,
    checkDbReachable(opts, deps),
  ]);

  return {
    checks,
    allOk: checks.every((c) => c.ok),
  };
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

export function renderDoctorReport(report: DoctorReport): string {
  const rows = report.checks.map((c) => {
    const icon = c.ok ? "pass" : "FAIL";
    return `  [${icon}] ${c.name.padEnd(20)} ${c.detail}`;
  });
  const summary = report.allOk ? "All checks passed." : "Some checks failed.";
  return `\n${rows.join("\n")}\n\n${summary}`;
}
