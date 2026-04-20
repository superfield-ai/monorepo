/**
 * Vultr provider helper for `superfield provision vultr`.
 *
 * Provisions:
 *   - One Ubuntu 24.04 LTS x64 instance (default plan `vc2-1c-2gb`,
 *     default region `ewr`).
 *   - One ephemeral Ed25519 SSH key uploaded via Vultr API and attached to
 *     the instance at creation. The derived deploy key is also attached.
 *   - Optionally one Vultr Managed Database
 *     (`vultr-dbaas-startup-cc-1-55-2`, PostgreSQL 16) with database `app`,
 *     user `app`, password derived from the mnemonic. Instance IP is added
 *     to the DB allow-list.
 *
 * All resources are tagged `superfield-env=<env>`. Subsequent runs reuse
 * existing resources by tag (idempotent).
 *
 * Tests intercept `https://api.vultr.com` via MSW v2; production code uses
 * the global `fetch`. No mocks are used.
 */

import { generateKeyPairSync } from "node:crypto";
import { derivePassword } from "../../secrets/index.ts";

export interface ProvisionOpts {
  region?: string;
  env: string;
  managedDb: boolean;
  derivedDeployKeyPublicOpenSsh: string;
  mnemonic?: Buffer;
  /** Override the API base URL. Test seam — defaults to https://api.vultr.com. */
  apiBase?: string;
  /** Override fetch. Test seam — defaults to global fetch. */
  fetch?: typeof fetch;
  /** Override env-var lookup. Test seam — defaults to process.env. */
  apiKey?: string;
  /** Sleep helper used while waiting for resources to become "active".
   *  Test seam — defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Polling cap. Defaults to 60 attempts. */
  maxPollAttempts?: number;
  /** Delay between polls in ms. Defaults to 5000. */
  pollDelayMs?: number;
}

export interface ProvisionResult {
  host: string;
  initialPrivateKeyPem: string;
  databaseUrl?: string;
}

export interface DestroyOpts {
  region?: string;
  env: string;
  apiBase?: string;
  fetch?: typeof fetch;
  apiKey?: string;
}

const DEFAULT_REGION = "ewr";
const DEFAULT_PLAN = "vc2-1c-2gb";
const DEFAULT_OS_ID = 2284; // Ubuntu 24.04 LTS x64
const DEFAULT_DB_PLAN = "vultr-dbaas-startup-cc-1-55-2";
const DEFAULT_DB_VERSION = "16";
const DEFAULT_DB_ENGINE = "pg";
const DEFAULT_API_BASE = "https://api.vultr.com";

function tagFor(env: string): string {
  return `superfield-env=${env}`;
}

function resolveApiKey(opts: { apiKey?: string }): string {
  const key = opts.apiKey ?? process.env.VULTR_API_KEY;
  if (typeof key !== "string" || key.length === 0) {
    throw new Error(
      "VULTR_API_KEY is not set. Export VULTR_API_KEY or pass `apiKey` explicitly.",
    );
  }
  return key;
}

interface VultrClient {
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
}

function makeClient(opts: {
  apiBase: string;
  apiKey: string;
  fetchImpl: typeof fetch;
}): VultrClient {
  const { apiBase, apiKey, fetchImpl } = opts;
  return {
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      const url = `${apiBase}${path}`;
      const init: RequestInit = {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }
      const res = await fetchImpl(url, init);
      const text = await res.text();
      if (!res.ok) {
        throw new Error(
          `Vultr API ${method} ${path} failed (${res.status} ${res.statusText}): ${text}`,
        );
      }
      if (text.length === 0) {
        return undefined as T;
      }
      return JSON.parse(text) as T;
    },
  };
}

// ---- SSH key generation ----

function generateEphemeralEd25519(): {
  publicKeyOpenSsh: string;
  privateKeyPem: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  const spkiDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const raw = spkiDer.subarray(spkiDer.length - 32);
  const algo = Buffer.from("ssh-ed25519", "utf8");
  const payload = Buffer.concat([sshString(algo), sshString(raw)]);
  const publicKeyOpenSsh = `ssh-ed25519 ${payload.toString("base64")}`;
  return { publicKeyOpenSsh, privateKeyPem };
}

function sshString(buf: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

// ---- Vultr response shapes (only the fields we use) ----

interface VultrSshKey {
  id: string;
  name: string;
  ssh_key: string;
}
interface VultrSshKeysList {
  ssh_keys: VultrSshKey[];
}
interface VultrSshKeyCreate {
  ssh_key: VultrSshKey;
}

interface VultrInstance {
  id: string;
  main_ip: string;
  status: string;
  server_status?: string;
  power_status?: string;
  tag?: string;
  tags?: string[];
}
interface VultrInstancesList {
  instances: VultrInstance[];
}
interface VultrInstanceCreate {
  instance: VultrInstance;
}

interface VultrDatabase {
  id: string;
  status: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  tag?: string;
  tags?: string[];
}
interface VultrDatabasesList {
  databases: VultrDatabase[];
}
interface VultrDatabaseCreate {
  database: VultrDatabase;
}

// ---- High-level helpers ----

async function findOrCreateSshKey(
  client: VultrClient,
  args: { name: string; publicKey: string },
): Promise<VultrSshKey> {
  const list = await client.request<VultrSshKeysList>("GET", "/v2/ssh-keys");
  const match = list.ssh_keys.find(
    (k) => k.name === args.name || k.ssh_key.trim() === args.publicKey.trim(),
  );
  if (match) return match;
  const created = await client.request<VultrSshKeyCreate>(
    "POST",
    "/v2/ssh-keys",
    { name: args.name, ssh_key: args.publicKey },
  );
  return created.ssh_key;
}

function instanceMatchesTag(inst: VultrInstance, tag: string): boolean {
  if (inst.tag === tag) return true;
  if (Array.isArray(inst.tags) && inst.tags.includes(tag)) return true;
  return false;
}

async function findInstanceByTag(
  client: VultrClient,
  tag: string,
): Promise<VultrInstance | undefined> {
  // Vultr supports `?tag=` filter; we also defensively re-check the field.
  const list = await client.request<VultrInstancesList>(
    "GET",
    `/v2/instances?tag=${encodeURIComponent(tag)}`,
  );
  return list.instances.find((i) => instanceMatchesTag(i, tag));
}

async function findDatabaseByTag(
  client: VultrClient,
  tag: string,
): Promise<VultrDatabase | undefined> {
  const list = await client.request<VultrDatabasesList>(
    "GET",
    `/v2/databases?tag=${encodeURIComponent(tag)}`,
  );
  return list.databases.find(
    (d) => d.tag === tag || (Array.isArray(d.tags) && d.tags.includes(tag)),
  );
}

async function waitForInstanceActive(
  client: VultrClient,
  id: string,
  sleep: (ms: number) => Promise<void>,
  maxAttempts: number,
  delayMs: number,
): Promise<VultrInstance> {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await client.request<{ instance: VultrInstance }>(
      "GET",
      `/v2/instances/${id}`,
    );
    const inst = res.instance;
    if (
      inst.status === "active" &&
      inst.main_ip &&
      inst.main_ip !== "0.0.0.0"
    ) {
      return inst;
    }
    await sleep(delayMs);
  }
  throw new Error(`Vultr instance ${id} did not become active in time`);
}

async function waitForDatabaseRunning(
  client: VultrClient,
  id: string,
  sleep: (ms: number) => Promise<void>,
  maxAttempts: number,
  delayMs: number,
): Promise<VultrDatabase> {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await client.request<{ database: VultrDatabase }>(
      "GET",
      `/v2/databases/${id}`,
    );
    const db = res.database;
    if (db.status === "Running" && db.host) {
      return db;
    }
    await sleep(delayMs);
  }
  throw new Error(`Vultr database ${id} did not become Running in time`);
}

// ---- Public API ----

export async function provision(opts: ProvisionOpts): Promise<ProvisionResult> {
  const region = opts.region ?? DEFAULT_REGION;
  const env = opts.env;
  if (typeof env !== "string" || env.length === 0) {
    throw new Error("provision({ env }) is required");
  }
  const apiKey = resolveApiKey(opts);
  const apiBase = opts.apiBase ?? DEFAULT_API_BASE;
  const fetchImpl = opts.fetch ?? fetch;
  const sleep =
    opts.sleep ??
    ((ms: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, ms)));
  const maxPollAttempts = opts.maxPollAttempts ?? 60;
  const pollDelayMs = opts.pollDelayMs ?? 5000;

  const client = makeClient({ apiBase, apiKey, fetchImpl });
  const tag = tagFor(env);

  // 1. Generate ephemeral SSH key and upload it (idempotent by name).
  const ephemeral = generateEphemeralEd25519();
  const ephemeralKey = await findOrCreateSshKey(client, {
    name: `superfield-${env}-ephemeral`,
    publicKey: ephemeral.publicKeyOpenSsh,
  });

  // 2. Upload the derived deploy key (idempotent by name).
  const derivedKey = await findOrCreateSshKey(client, {
    name: `superfield-${env}-deploy`,
    publicKey: opts.derivedDeployKeyPublicOpenSsh,
  });

  // 3. Find or create the instance, tagged with the env.
  let instance = await findInstanceByTag(client, tag);
  if (!instance) {
    const created = await client.request<VultrInstanceCreate>(
      "POST",
      "/v2/instances",
      {
        region,
        plan: DEFAULT_PLAN,
        os_id: DEFAULT_OS_ID,
        label: `superfield-${env}`,
        hostname: `superfield-${env}`,
        sshkey_id: [ephemeralKey.id, derivedKey.id],
        tag,
        tags: [tag],
        backups: "disabled",
      },
    );
    instance = created.instance;
  }

  instance = await waitForInstanceActive(
    client,
    instance.id,
    sleep,
    maxPollAttempts,
    pollDelayMs,
  );

  let databaseUrl: string | undefined;

  if (opts.managedDb) {
    if (!opts.mnemonic) {
      throw new Error(
        "provision({ managedDb: true }) requires a mnemonic Buffer",
      );
    }

    let database = await findDatabaseByTag(client, tag);
    if (!database) {
      const created = await client.request<VultrDatabaseCreate>(
        "POST",
        "/v2/databases",
        {
          database_engine: DEFAULT_DB_ENGINE,
          database_engine_version: DEFAULT_DB_VERSION,
          region,
          plan: DEFAULT_DB_PLAN,
          label: `superfield-${env}-db`,
          tag,
          tags: [tag],
        },
      );
      database = created.database;
    }

    database = await waitForDatabaseRunning(
      client,
      database.id,
      sleep,
      maxPollAttempts,
      pollDelayMs,
    );

    // Derive the deterministic password. derivePassword zeros the mnemonic.
    const password = derivePassword(opts.mnemonic, env, "db-password", 32);

    // Best-effort password reset on the `app` user. If the user doesn't
    // exist yet, create it. Vultr returns 404 for unknown users; that just
    // means we need to create it.
    try {
      await client.request<unknown>(
        "PUT",
        `/v2/databases/${database.id}/users/app`,
        { password },
      );
    } catch (e) {
      if (
        e instanceof Error &&
        (e.message.includes("404") || e.message.includes("not found"))
      ) {
        await client.request<unknown>(
          "POST",
          `/v2/databases/${database.id}/users`,
          { username: "app", password },
        );
      } else {
        throw e;
      }
    }

    // Best-effort: create the `app` database. Ignore "already exists".
    try {
      await client.request<unknown>(
        "POST",
        `/v2/databases/${database.id}/databases`,
        { name: "app" },
      );
    } catch (e) {
      if (
        !(e instanceof Error) ||
        (!e.message.includes("already") && !e.message.includes("409"))
      ) {
        throw e;
      }
    }

    // Allow inbound from the instance IP.
    await client.request<unknown>(
      "POST",
      `/v2/databases/${database.id}/access-control`,
      { acl: [{ source: `${instance.main_ip}/32` }] },
    );

    const host = database.host ?? "";
    const port = database.port ?? 16751;
    databaseUrl = `postgresql://app:${password}@${host}:${port}/app?sslmode=require`;
  }

  return {
    host: instance.main_ip,
    initialPrivateKeyPem: ephemeral.privateKeyPem,
    databaseUrl,
  };
}

export async function destroy(opts: DestroyOpts): Promise<void> {
  const env = opts.env;
  if (typeof env !== "string" || env.length === 0) {
    throw new Error("destroy({ env }) is required");
  }
  const apiKey = resolveApiKey(opts);
  const apiBase = opts.apiBase ?? DEFAULT_API_BASE;
  const fetchImpl = opts.fetch ?? fetch;
  const client = makeClient({ apiBase, apiKey, fetchImpl });
  const tag = tagFor(env);

  const instance = await findInstanceByTag(client, tag);
  if (instance) {
    await client.request<unknown>("DELETE", `/v2/instances/${instance.id}`);
  }

  const database = await findDatabaseByTag(client, tag);
  if (database) {
    await client.request<unknown>("DELETE", `/v2/databases/${database.id}`);
  }

  // SSH keys are cheap to leave around, but we tagged them by env in the
  // name so we can clean them up too.
  const keys = await client.request<VultrSshKeysList>("GET", "/v2/ssh-keys");
  for (const k of keys.ssh_keys) {
    if (
      k.name === `superfield-${env}-ephemeral` ||
      k.name === `superfield-${env}-deploy`
    ) {
      await client.request<unknown>("DELETE", `/v2/ssh-keys/${k.id}`);
    }
  }
}
