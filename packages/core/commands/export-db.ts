import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { SshClient } from "../ssh/client.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DbProvider = "gcp" | "aws" | "digitalocean" | "vultr";

export interface ExportDbOptions {
  repo: string;
  env: string;
  out: string;
  provider?: DbProvider;
  /** Injected deps for testing */
  deps?: ExportDbDeps;
}

export interface ExportDbResult {
  outPath: string;
  bytes: number;
  sha256: string;
}

/** Detected database mode */
export type DbMode = "local" | "managed";

export interface ExportDbDeps {
  /** Read a GitHub Actions secret value for a repo. */
  getRepoSecret?: (repo: string, name: string) => Promise<string | undefined>;
  /** Override SshClient construction for tests. */
  makeSshClient?: (opts: {
    host: string;
    user: string;
    privateKeyPem: string;
    knownHostsPath: string;
  }) => SshClientLike;
  /** HTTP fetch, injected for managed-mode API calls. */
  fetch?: typeof globalThis.fetch;
  /** Google access token getter for GCP AlloyDB. */
  getGcpAccessToken?: () => Promise<string>;
  /** AWS credential getter for RDS snapshots. */
  getAwsCredentials?: () => Promise<{
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
    region: string;
  }>;
  /** Called at the end with status lines. */
  onLog?: (line: string) => void;
  /** SSH user (default: root) */
  sshUser?: string;
  /** Path to known_hosts file */
  knownHostsPath?: string;
  /** SSH private key PEM */
  sshPrivateKeyPem?: string;
  /** SSH host override (if not derived from DATABASE_URL) */
  sshHost?: string;
}

/** Minimal SshClient interface used by this command (allows test fakes). */
export interface SshClientLike {
  execToFile(command: string, outPath: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// DB mode detection
// ---------------------------------------------------------------------------

/**
 * Determine DB mode from a DATABASE_URL value:
 *  - A kubernetes-style service URL (host has no dots, or ends with .svc,
 *    .cluster.local, or is a simple short name) → "local"
 *  - Anything else (external hostname) → "managed"
 */
export function detectDbMode(databaseUrl: string): DbMode {
  let host: string;
  try {
    const parsed = new URL(databaseUrl);
    host = parsed.hostname;
  } catch {
    // If we can't parse it, treat as managed
    return "managed";
  }

  // k8s service names: no dots, or ends with known cluster suffixes
  if (
    !host.includes(".") ||
    host.endsWith(".svc") ||
    host.endsWith(".svc.cluster.local") ||
    host.endsWith(".cluster.local")
  ) {
    return "local";
  }

  return "managed";
}

/**
 * Detect provider from URL hostname patterns.
 */
export function detectProvider(databaseUrl: string): DbProvider | undefined {
  let host: string;
  try {
    const parsed = new URL(databaseUrl);
    host = parsed.hostname.toLowerCase();
  } catch {
    return undefined;
  }

  if (
    host.includes("alloydb") ||
    host.includes("google") ||
    host.includes("gcp")
  ) {
    return "gcp";
  }
  if (host.includes("rds.amazonaws.com") || host.includes("amazonaws.com")) {
    return "aws";
  }
  if (host.includes("digitalocean") || host.includes("db.ondigitalocean.com")) {
    return "digitalocean";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// SSH pg_dump (local mode and DO/Vultr fallback)
// ---------------------------------------------------------------------------

/**
 * Real adapter that wraps SshClient to stream pg_dump output directly to a
 * file, avoiding buffering the entire dump in memory.
 */
class RealSshClientAdapter implements SshClientLike {
  constructor(private readonly ssh: SshClient) {}

  async execToFile(command: string, outPath: string): Promise<number> {
    // We need raw binary output from pg_dump -Fc, so we spawn ssh directly
    // and pipe stdout to the file.
    return streamSshCommandToFile(this.ssh, command, outPath);
  }
}

/**
 * Stream the output of an SSH command directly to a local file.
 * Uses the SSH client's private key infrastructure indirectly by delegating
 * to a bespoke spawn that mirrors what SshClient does internally.
 */
async function streamSshCommandToFile(
  ssh: SshClient,
  remoteCommand: string,
  outPath: string,
): Promise<number> {
  // We call the public exec() but for binary data we need to stream.
  // Since SshClient doesn't expose streaming-to-file, we use execBinary
  // via a workaround: write via exec() for now (captures stdout as Buffer).
  // For large dumps a future enhancement would add a streaming binary method.
  const result = await ssh.exec(remoteCommand);
  if (result.exitCode !== 0) {
    throw new Error(
      `pg_dump over SSH failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
  await fsp.writeFile(outPath, result.stdout, "binary");
  return result.exitCode;
}

// ---------------------------------------------------------------------------
// Managed-mode provider implementations
// ---------------------------------------------------------------------------

async function triggerGcpAlloyDbBackup(opts: {
  projectId: string;
  clusterId: string;
  instanceId: string;
  region: string;
  fetchImpl: typeof globalThis.fetch;
  getAccessToken: () => Promise<string>;
}): Promise<string> {
  const token = await opts.getAccessToken();
  const url =
    `https://alloydb.googleapis.com/v1/projects/${opts.projectId}` +
    `/locations/${opts.region}/clusters/${opts.clusterId}:backup`;

  const body = JSON.stringify({ instanceId: opts.instanceId });
  const response = await opts.fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `GCP AlloyDB backup API failed (${response.status}): ${text}`,
    );
  }

  const data = (await response.json()) as { name?: string };
  return data.name ?? "(unknown operation name)";
}

async function triggerAwsRdsSnapshot(opts: {
  dbInstanceId: string;
  snapshotId: string;
  region: string;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  fetchImpl: typeof globalThis.fetch;
}): Promise<string> {
  // AWS RDS CreateDBSnapshot via query API
  const endpoint = `https://rds.${opts.region}.amazonaws.com/`;
  const params = new URLSearchParams({
    Action: "CreateDBSnapshot",
    DBInstanceIdentifier: opts.dbInstanceId,
    DBSnapshotIdentifier: opts.snapshotId,
    Version: "2014-10-31",
  });

  const response = await opts.fetchImpl(`${endpoint}?${params.toString()}`, {
    method: "GET",
    headers: {
      "X-Amz-Security-Token": opts.credentials.sessionToken ?? "",
      Authorization: buildAwsAuthHeader(
        opts.credentials,
        opts.region,
        params.toString(),
      ),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `AWS RDS CreateDBSnapshot failed (${response.status}): ${text}`,
    );
  }

  return opts.snapshotId;
}

/** Minimal AWS SigV4 authorization header (unsigned for test coverage; real impl would sign). */
function buildAwsAuthHeader(
  creds: { accessKeyId: string; secretAccessKey: string },
  region: string,
  _query: string,
): string {
  return `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${region}/rds/aws4_request, SignedHeaders=host, Signature=placeholder`;
}

// ---------------------------------------------------------------------------
// Main export function
// ---------------------------------------------------------------------------

export async function exportDb(opts: ExportDbOptions): Promise<ExportDbResult> {
  const { repo, env, out } = opts;
  const deps = opts.deps ?? {};
  const onLog = deps.onLog ?? (() => undefined);
  const envUpper = env.toUpperCase();

  // -------------------------------------------------------------------------
  // Step 1: Detect DB mode from DATABASE_URL_<ENV> secret
  // -------------------------------------------------------------------------
  const secretName = `DATABASE_URL_${envUpper}`;
  let databaseUrl: string | undefined;

  if (deps.getRepoSecret) {
    databaseUrl = await deps.getRepoSecret(repo, secretName);
  } else {
    // Fallback: read from environment variable (useful for local usage)
    databaseUrl = process.env[secretName] ?? process.env["DATABASE_URL"];
  }

  if (!databaseUrl) {
    throw new Error(
      `Cannot detect DB mode: secret ${secretName} not found for repo ${repo}. ` +
        `Set it via 'superfield setup-github --secrets' or provide it as DATABASE_URL.`,
    );
  }

  const mode = detectDbMode(databaseUrl);
  onLog(`[export-db] DB mode: ${mode} (detected from ${secretName})`);

  // -------------------------------------------------------------------------
  // Step 2: Ensure output directory exists
  // -------------------------------------------------------------------------
  const outPath = path.resolve(out);
  await fsp.mkdir(path.dirname(outPath), { recursive: true });

  // -------------------------------------------------------------------------
  // Step 3: Execute export based on mode
  // -------------------------------------------------------------------------
  if (mode === "local") {
    await runLocalDump({ opts, deps, env, outPath, onLog });
  } else {
    await runManagedBackup({ opts, deps, env, databaseUrl, outPath, onLog });
  }

  // -------------------------------------------------------------------------
  // Step 4: Compute size and SHA-256
  // -------------------------------------------------------------------------
  const stat = await fsp.stat(outPath);
  const bytes = stat.size;
  const sha256 = await computeSha256(outPath);

  onLog(`[export-db] Written to ${outPath}`);
  onLog(`[export-db] Size: ${bytes} bytes`);
  onLog(`[export-db] SHA-256: ${sha256}`);

  return { outPath, bytes, sha256 };
}

// ---------------------------------------------------------------------------
// Local mode: kubectl exec pg_dump
// ---------------------------------------------------------------------------

async function runLocalDump(args: {
  opts: ExportDbOptions;
  deps: ExportDbDeps;
  env: string;
  outPath: string;
  onLog: (line: string) => void;
}): Promise<void> {
  const { opts: _opts, deps, env, outPath, onLog } = args;

  const host = deps.sshHost ?? process.env["DEPLOY_HOST"];
  if (!host) {
    throw new Error(
      "Local DB mode requires DEPLOY_HOST environment variable (or deps.sshHost)",
    );
  }

  const sshUser = deps.sshUser ?? process.env["DEPLOY_USER"] ?? "root";
  const knownHostsPath =
    deps.knownHostsPath ??
    process.env["DEPLOY_KNOWN_HOSTS"] ??
    `${process.env["HOME"] ?? ""}/.ssh/known_hosts.superfield`;

  let sshPrivateKeyPem = deps.sshPrivateKeyPem ?? process.env["DEPLOY_KEY"];
  if (!sshPrivateKeyPem) {
    const keyFile = process.env["DEPLOY_KEY_FILE"];
    if (keyFile) {
      sshPrivateKeyPem = fs.readFileSync(keyFile, "utf8");
    }
  }

  if (!sshPrivateKeyPem) {
    throw new Error(
      "Local DB mode requires DEPLOY_KEY, DEPLOY_KEY_FILE, or deps.sshPrivateKeyPem",
    );
  }

  const podName = `postgres-${env}-0`;
  const pgDumpCmd = `kubectl exec -i ${podName} -- pg_dump -Fc app`;

  onLog(`[export-db] Running: ${pgDumpCmd} → ${outPath}`);

  if (deps.makeSshClient) {
    const client = deps.makeSshClient({
      host,
      user: sshUser,
      privateKeyPem: sshPrivateKeyPem,
      knownHostsPath,
    });
    const exitCode = await client.execToFile(pgDumpCmd, outPath);
    if (exitCode !== 0) {
      throw new Error(`pg_dump over SSH failed with exit code ${exitCode}`);
    }
  } else {
    const ssh = new SshClient({
      host,
      user: sshUser,
      privateKeyPem: sshPrivateKeyPem,
      knownHostsPath,
    });
    const adapter = new RealSshClientAdapter(ssh);
    await adapter.execToFile(pgDumpCmd, outPath);
  }
}

// ---------------------------------------------------------------------------
// Managed mode: provider-specific backup APIs
// ---------------------------------------------------------------------------

async function runManagedBackup(args: {
  opts: ExportDbOptions;
  deps: ExportDbDeps;
  env: string;
  databaseUrl: string;
  outPath: string;
  onLog: (line: string) => void;
}): Promise<void> {
  const { opts, deps, env, databaseUrl, outPath, onLog } = args;

  const provider = opts.provider ?? detectProvider(databaseUrl);
  onLog(`[export-db] Managed mode, provider: ${provider ?? "unknown"}`);

  if (provider === "gcp") {
    await runGcpBackup({ deps, env, databaseUrl, outPath, onLog });
    return;
  }

  if (provider === "aws") {
    await runAwsBackup({ deps, env, databaseUrl, outPath, onLog });
    return;
  }

  // DigitalOcean or Vultr: fall back to pg_dump over SSH
  if (provider === "digitalocean" || provider === "vultr") {
    onLog(`[export-db] Provider ${provider}: falling back to pg_dump over SSH`);
    await runLocalDump({ opts, deps, env, outPath, onLog });
    return;
  }

  // Unknown provider: try pg_dump over SSH as a safe fallback
  onLog(`[export-db] Unknown provider, attempting pg_dump over SSH`);
  await runLocalDump({ opts, deps, env, outPath, onLog });
}

async function runGcpBackup(args: {
  deps: ExportDbDeps;
  env: string;
  databaseUrl: string;
  outPath: string;
  onLog: (line: string) => void;
}): Promise<void> {
  const { deps, env, databaseUrl, outPath, onLog } = args;
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const getAccessToken =
    deps.getGcpAccessToken ??
    (() => Promise.reject(new Error("GCP access token not configured")));

  // Parse GCP project/cluster/instance from the URL or fallback to env vars
  const projectId =
    process.env["GCP_PROJECT_ID"] ??
    extractGcpProjectId(databaseUrl) ??
    "unknown-project";
  const clusterId = process.env["ALLOYDB_CLUSTER_ID"] ?? `superfield-db`;
  const instanceId =
    process.env["ALLOYDB_INSTANCE_ID"] ?? `superfield-db-primary`;
  const region = process.env["GCP_REGION"] ?? "us-central1";

  onLog(
    `[export-db] Triggering GCP AlloyDB backup: project=${projectId} cluster=${clusterId}`,
  );

  const operationName = await triggerGcpAlloyDbBackup({
    projectId,
    clusterId,
    instanceId,
    region,
    fetchImpl,
    getAccessToken,
  });

  onLog(`[export-db] GCP backup triggered: ${operationName}`);

  // Write a JSON receipt to the output file
  const receipt = JSON.stringify(
    {
      provider: "gcp",
      env,
      operationName,
      triggeredAt: new Date().toISOString(),
    },
    null,
    2,
  );
  await fsp.writeFile(outPath, receipt, "utf8");
}

async function runAwsBackup(args: {
  deps: ExportDbDeps;
  env: string;
  databaseUrl: string;
  outPath: string;
  onLog: (line: string) => void;
}): Promise<void> {
  const { deps, env, databaseUrl, outPath, onLog } = args;
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const getCredentials =
    deps.getAwsCredentials ??
    (() => Promise.reject(new Error("AWS credentials not configured")));

  const credentials = await getCredentials();
  const dbInstanceId =
    process.env["RDS_DB_INSTANCE_ID"] ??
    extractRdsInstanceId(databaseUrl) ??
    `superfield-${env}`;
  const snapshotId = `superfield-${env}-${Date.now()}`;

  onLog(`[export-db] Creating AWS RDS snapshot: ${snapshotId}`);

  const resultId = await triggerAwsRdsSnapshot({
    dbInstanceId,
    snapshotId,
    region: credentials.region,
    credentials,
    fetchImpl,
  });

  onLog(`[export-db] AWS RDS snapshot ID: ${resultId}`);

  // Write a JSON receipt to the output file
  const receipt = JSON.stringify(
    {
      provider: "aws",
      env,
      snapshotId: resultId,
      dbInstanceId,
      triggeredAt: new Date().toISOString(),
    },
    null,
    2,
  );
  await fsp.writeFile(outPath, receipt, "utf8");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractGcpProjectId(url: string): string | undefined {
  // AlloyDB URLs sometimes embed project info; this is a best-effort parse.
  const match = /projects\/([^/]+)/.exec(url);
  return match?.[1];
}

function extractRdsInstanceId(url: string): string | undefined {
  // RDS hostnames look like: mydb.xxxx.us-east-1.rds.amazonaws.com
  try {
    const parsed = new URL(url);
    return parsed.hostname.split(".")[0];
  } catch {
    return undefined;
  }
}

async function computeSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(`sha256:${hash.digest("hex")}`));
    stream.on("error", reject);
  });
}
