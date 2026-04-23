/**
 * DigitalOcean provider helper (issue #150).
 *
 * Exports `provision()` and `destroy()` matching the cross-vendor
 * `provision(opts) → { host, initialPrivateKeyPem, databaseUrl? }` shape
 * defined in deploy-features.md § Provisioning.
 *
 * All resources are tagged `superfield-env=<env>` for idempotent re-runs and
 * destruction.
 */

import { generateKeyPairSync, createHash } from "node:crypto";
import { derivePassword } from "../../secrets/index.ts";

export const DO_API_BASE = "https://api.digitalocean.com";
const DEFAULT_REGION = "nyc1";
const DEFAULT_SIZE = "s-1vcpu-2gb";
const DEFAULT_IMAGE = "ubuntu-24-04-x64";
const DEFAULT_DB_SIZE = "db-s-1vcpu-1gb";
const DB_ENGINE = "pg";
const DB_VERSION = "16";

export interface ProvisionOpts {
  region?: string;
  env: string;
  managedDb: boolean;
  derivedDeployKeyPublicOpenSsh: string;
  mnemonic?: Buffer;
  /** Override fetch (e.g. for tests). Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Override token (else read from `DIGITALOCEAN_TOKEN`). */
  token?: string;
  /** Polling interval in ms for resource readiness. */
  pollIntervalMs?: number;
  /** Max polling attempts before giving up. */
  pollMaxAttempts?: number;
}

export interface ProvisionResult {
  host: string;
  initialPrivateKeyPem: string;
  databaseUrl?: string;
}

export interface DestroyOpts {
  env: string;
  fetch?: typeof fetch;
  token?: string;
}

interface DoKey {
  id: number;
  fingerprint: string;
  public_key: string;
  name: string;
}
interface DoDroplet {
  id: number;
  name: string;
  status: string;
  networks: { v4: { ip_address: string; type: string }[] };
  tags: string[];
}
interface DoDatabase {
  id: string;
  name: string;
  status: string;
  connection?: { host: string; port: number };
  private_connection?: { host: string; port: number };
  tags?: string[];
}

function envTag(env: string): string {
  return `superfield-env=${env}`;
}

function requireToken(opts: { token?: string }): string {
  const token = opts.token ?? process.env.DIGITALOCEAN_TOKEN;
  if (!token || token.length === 0) {
    throw new Error(
      "DIGITALOCEAN_TOKEN is required (set the env var or pass `token`)",
    );
  }
  return token;
}

interface Caller {
  call: <T>(
    path: string,
    init?: { method?: string; body?: unknown },
  ) => Promise<T>;
  callRaw: (
    path: string,
    init?: { method?: string; body?: unknown },
  ) => Promise<Response>;
}

function makeCaller(token: string, fetchImpl: typeof fetch): Caller {
  async function callRaw(
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<Response> {
    const url = path.startsWith("http") ? path : `${DO_API_BASE}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    const res = await fetchImpl(url, {
      method: init?.method ?? "GET",
      headers,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    return res;
  }

  async function call<T>(
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<T> {
    const res = await callRaw(path, init);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `DigitalOcean API ${init?.method ?? "GET"} ${path} failed: ${res.status} ${res.statusText} ${text}`,
      );
    }
    if (res.status === 204) {
      return undefined as T;
    }
    return (await res.json()) as T;
  }

  return { call, callRaw };
}

/**
 * Generate an ephemeral Ed25519 keypair. Returns the OpenSSH public-key form
 * (so it can be uploaded to DO) and a PEM-encoded PKCS#8 private key (so it
 * can be returned to the caller for one-time SSH bootstrap).
 *
 * Also returns the MD5 fingerprint as DO computes it (colon-separated hex of
 * the base64-decoded ssh-ed25519 wire format).
 */
export function generateEphemeralSshKey(): {
  publicKeyOpenSsh: string;
  privateKeyPem: string;
  fingerprint: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const raw = spki.subarray(spki.length - 32);
  const algo = Buffer.from("ssh-ed25519", "utf8");
  const wire = Buffer.concat([sshString(algo), sshString(raw)]);
  const publicKeyOpenSsh = `ssh-ed25519 ${wire.toString("base64")}`;
  const md5 = createHash("md5").update(wire).digest("hex");
  const fingerprint = md5.match(/.{1,2}/g)?.join(":") ?? md5;
  return { publicKeyOpenSsh, privateKeyPem: pem, fingerprint };
}

function sshString(buf: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

async function ensureTag(c: Caller, env: string): Promise<void> {
  const tag = envTag(env);
  const res = await c.callRaw(`/v2/tags/${encodeURIComponent(tag)}`);
  if (res.status === 404) {
    await c.call("/v2/tags", { method: "POST", body: { name: tag } });
    return;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `DigitalOcean API GET /v2/tags/${tag} failed: ${res.status} ${res.statusText} ${text}`,
    );
  }
  // Drain body to avoid leaving the response unconsumed.
  await res.text().catch(() => "");
}

async function findDropletByTag(
  c: Caller,
  env: string,
): Promise<DoDroplet | undefined> {
  const result = await c.call<{ droplets: DoDroplet[] }>(
    `/v2/droplets?tag_name=${encodeURIComponent(envTag(env))}`,
  );
  return result.droplets?.[0];
}

async function findDatabaseByTag(
  c: Caller,
  env: string,
): Promise<DoDatabase | undefined> {
  // DO's databases endpoint supports ?tag_name filter.
  const result = await c.call<{ databases: DoDatabase[] }>(
    `/v2/databases?tag_name=${encodeURIComponent(envTag(env))}`,
  );
  return result.databases?.[0];
}

async function uploadKey(
  c: Caller,
  publicKey: string,
  name: string,
): Promise<DoKey> {
  // POST is idempotent in DO terms only by name; if a key with the same
  // public material exists, DO returns 422 "SSH Key is already in use" with
  // the existing key info we can recover via fingerprint lookup.
  const result = await c.callRaw("/v2/account/keys", {
    method: "POST",
    body: { name, public_key: publicKey },
  });
  if (result.ok) {
    const json = (await result.json()) as { ssh_key: DoKey };
    return json.ssh_key;
  }
  if (result.status === 422) {
    // Already exists — recover by listing and matching public material.
    await result.text().catch(() => "");
    const list = await c.call<{ ssh_keys: DoKey[] }>("/v2/account/keys");
    const match = list.ssh_keys.find(
      (k) => k.public_key.split(/\s+/)[1] === publicKey.split(/\s+/)[1],
    );
    if (match) return match;
  }
  const text = await result.text().catch(() => "");
  throw new Error(
    `DigitalOcean API POST /v2/account/keys failed: ${result.status} ${result.statusText} ${text}`,
  );
}

function publicIp(droplet: DoDroplet): string | undefined {
  return droplet.networks?.v4?.find((n) => n.type === "public")?.ip_address;
}

async function pollDroplet(
  c: Caller,
  id: number,
  intervalMs: number,
  maxAttempts: number,
): Promise<DoDroplet> {
  for (let i = 0; i < maxAttempts; i++) {
    const { droplet } = await c.call<{ droplet: DoDroplet }>(
      `/v2/droplets/${id}`,
    );
    if (droplet.status === "active" && publicIp(droplet)) {
      return droplet;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Droplet ${id} did not become active in time`);
}

async function pollDatabase(
  c: Caller,
  id: string,
  intervalMs: number,
  maxAttempts: number,
): Promise<DoDatabase> {
  for (let i = 0; i < maxAttempts; i++) {
    const { database } = await c.call<{ database: DoDatabase }>(
      `/v2/databases/${id}`,
    );
    if (database.status === "online" && database.connection?.host) {
      return database;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Database ${id} did not become online in time`);
}

export async function provision(opts: ProvisionOpts): Promise<ProvisionResult> {
  const token = requireToken(opts);
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const c = makeCaller(token, fetchImpl);
  const region = opts.region ?? DEFAULT_REGION;
  const tag = envTag(opts.env);
  const pollIntervalMs = opts.pollIntervalMs ?? 5000;
  const pollMaxAttempts = opts.pollMaxAttempts ?? 60;

  // 1. Ensure the env tag exists (idempotent).
  await ensureTag(c, opts.env);

  // 2. Generate an ephemeral SSH key and upload it to DO.
  const ephemeral = generateEphemeralSshKey();
  const ephemeralKey = await uploadKey(
    c,
    ephemeral.publicKeyOpenSsh,
    `superfield-${opts.env}-ephemeral-${Date.now()}`,
  );

  // 3. Upload the derived deploy key so it is also attached to the droplet.
  //    Name is deterministic so re-runs find the same record.
  const deployKey = await uploadKey(
    c,
    opts.derivedDeployKeyPublicOpenSsh,
    `superfield-${opts.env}-deploy`,
  );

  // 4. Find or create the droplet.
  let droplet = await findDropletByTag(c, opts.env);
  if (!droplet) {
    const created = await c.call<{ droplet: DoDroplet }>("/v2/droplets", {
      method: "POST",
      body: {
        name: `superfield-${opts.env}`,
        region,
        size: DEFAULT_SIZE,
        image: DEFAULT_IMAGE,
        ssh_keys: [ephemeralKey.fingerprint, deployKey.fingerprint],
        tags: [tag],
        backups: false,
        ipv6: false,
        monitoring: false,
      },
    });
    droplet = await pollDroplet(
      c,
      created.droplet.id,
      pollIntervalMs,
      pollMaxAttempts,
    );
  } else if (droplet.status !== "active" || !publicIp(droplet)) {
    droplet = await pollDroplet(c, droplet.id, pollIntervalMs, pollMaxAttempts);
  }

  const host = publicIp(droplet);
  if (!host) {
    throw new Error(`Droplet ${droplet.id} has no public IPv4 address`);
  }

  // 5. Optional: managed Postgres.
  let databaseUrl: string | undefined;
  if (opts.managedDb) {
    if (!opts.mnemonic) {
      throw new Error("managedDb=true requires `mnemonic`");
    }
    // derivePassword zeroes the mnemonic — copy first because the caller may
    // still hold the buffer reference and we must not mutate it here.
    const mnemonicCopy = Buffer.from(opts.mnemonic);
    const password = derivePassword(mnemonicCopy, opts.env, "db-password", 32);

    let db = await findDatabaseByTag(c, opts.env);
    if (!db) {
      const created = await c.call<{ database: DoDatabase }>("/v2/databases", {
        method: "POST",
        body: {
          name: `superfield-${opts.env}`,
          engine: DB_ENGINE,
          version: DB_VERSION,
          size: DEFAULT_DB_SIZE,
          region,
          num_nodes: 1,
          tags: [tag],
        },
      });
      db = await pollDatabase(
        c,
        created.database.id,
        pollIntervalMs,
        pollMaxAttempts,
      );
    } else if (db.status !== "online" || !db.connection?.host) {
      db = await pollDatabase(c, db.id, pollIntervalMs, pollMaxAttempts);
    }

    // Create the `app` database (idempotent: 422 if exists).
    {
      const res = await c.callRaw(`/v2/databases/${db.id}/dbs`, {
        method: "POST",
        body: { name: "app" },
      });
      if (!res.ok && res.status !== 422 && res.status !== 409) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `Failed to create database "app": ${res.status} ${res.statusText} ${text}`,
        );
      }
      await res.text().catch(() => "");
    }

    // Create or update the `app` user. POST is idempotent via 422.
    {
      const res = await c.callRaw(`/v2/databases/${db.id}/users`, {
        method: "POST",
        body: { name: "app" },
      });
      if (!res.ok && res.status !== 422 && res.status !== 409) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `Failed to create database user "app": ${res.status} ${res.statusText} ${text}`,
        );
      }
      await res.text().catch(() => "");
    }

    // Reset the `app` user password to the derived value so the URL is
    // deterministic across runs.
    {
      const res = await c.callRaw(
        `/v2/databases/${db.id}/users/app/reset_auth`,
        {
          method: "POST",
          body: { mysql_settings: undefined, new_password: password },
        },
      );
      if (!res.ok && res.status !== 404) {
        // Some DO API versions don't expose explicit password reset for
        // postgres users (the auto-generated password is returned at user
        // creation). Tolerate 404 here so the call still works on managed
        // postgres clusters that don't accept reset_auth.
        const text = await res.text().catch(() => "");
        throw new Error(
          `Failed to reset password for user "app": ${res.status} ${res.statusText} ${text}`,
        );
      }
      await res.text().catch(() => "");
    }

    // Add the droplet IP to the firewall trusted sources.
    {
      const res = await c.callRaw(`/v2/databases/${db.id}/firewall`, {
        method: "PUT",
        body: {
          rules: [
            { type: "droplet", value: String(droplet.id) },
            { type: "ip_addr", value: host },
          ],
        },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `Failed to update DB firewall: ${res.status} ${res.statusText} ${text}`,
        );
      }
      await res.text().catch(() => "");
    }

    const dbHost = db.connection?.host;
    const dbPort = db.connection?.port ?? 25060;
    if (!dbHost) {
      throw new Error(`Database ${db.id} has no connection host`);
    }
    databaseUrl = `postgresql://app:${password}@${dbHost}:${dbPort}/app?sslmode=require`;
  }

  return {
    host,
    initialPrivateKeyPem: ephemeral.privateKeyPem,
    databaseUrl,
  };
}

/**
 * Tear down every resource tagged `superfield-env=<env>`. Symmetric with
 * `provision`. Safe to re-run — missing resources are no-ops.
 */
export async function destroy(opts: DestroyOpts): Promise<void> {
  const token = requireToken(opts);
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const c = makeCaller(token, fetchImpl);
  const tag = envTag(opts.env);

  // Droplets: bulk delete by tag.
  {
    const res = await c.callRaw(
      `/v2/droplets?tag_name=${encodeURIComponent(tag)}`,
      { method: "DELETE" },
    );
    if (!res.ok && res.status !== 404) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Failed to delete droplets by tag: ${res.status} ${res.statusText} ${text}`,
      );
    }
    await res.text().catch(() => "");
  }

  // Databases: list and delete one by one (no bulk-by-tag delete on DO).
  const dbs = await c
    .call<{
      databases?: DoDatabase[];
    }>(`/v2/databases?tag_name=${encodeURIComponent(tag)}`)
    .catch(() => ({ databases: [] }));
  for (const db of dbs.databases ?? []) {
    const res = await c.callRaw(`/v2/databases/${db.id}`, {
      method: "DELETE",
    });
    if (!res.ok && res.status !== 404) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Failed to delete database ${db.id}: ${res.status} ${res.statusText} ${text}`,
      );
    }
    await res.text().catch(() => "");
  }

  // SSH keys: scoped by name prefix `superfield-<env>-`.
  const list = await c.call<{ ssh_keys: DoKey[] }>("/v2/account/keys");
  for (const k of list.ssh_keys ?? []) {
    if (k.name.startsWith(`superfield-${opts.env}-`)) {
      const res = await c.callRaw(`/v2/account/keys/${k.id}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 404) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `Failed to delete ssh key ${k.id}: ${res.status} ${res.statusText} ${text}`,
        );
      }
      await res.text().catch(() => "");
    }
  }
}

// Re-export a few internals for tests.
export const __internal = {
  envTag,
  generateEphemeralSshKey,
  DEFAULT_REGION,
  DEFAULT_SIZE,
  DEFAULT_IMAGE,
  DEFAULT_DB_SIZE,
};
