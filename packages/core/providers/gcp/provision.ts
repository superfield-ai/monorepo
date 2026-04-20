import { googleJsonRequest } from "../../gcp/http.ts";
import type { HttpDeps } from "../../gcp/http.ts";
import { pollOperation } from "../../gcp/operations.ts";
import { derivePassword } from "../../secrets/index.ts";
import { generateEphemeralSshKey } from "./ssh-key.ts";

// ── Constants ────────────────────────────────────────────────────────────────

const COMPUTE_BASE = "https://www.googleapis.com/compute/v1";
const ALLOYDB_BASE = "https://alloydb.googleapis.com/v1";
const SERVICE_NET_BASE = "https://servicenetworking.googleapis.com";

const DEFAULT_MACHINE_TYPE = "e2-small";
const DEFAULT_DISK_GB = 40;
const SSH_USER = "superfield";
const APP_DB_NAME = "app";
const APP_DB_USER = "app";
const ALLOYDB_CPU_COUNT = 2; // db-standard-2 equivalent

export interface ProvisionOpts {
  projectId: string;
  region: string;
  zone: string;
  env: string;
  managedDb: boolean;
  /** OpenSSH public key derived from the operator mnemonic (for post-bootstrap SSH). */
  derivedDeployKeyPublicOpenSsh: string;
  /** Required when managedDb=true. Used only to derive the DB password; zeroed by `derivePassword`. */
  mnemonic?: Buffer;
}

export interface ProvisionResult {
  /** External IP address of the VM. */
  host: string;
  /** Ephemeral first-bootstrap private key (PKCS#8 PEM). NOT mnemonic-derived. */
  initialPrivateKeyPem: string;
  /** Postgres URL targeting AlloyDB private IP. Present iff managedDb=true. */
  databaseUrl?: string;
}

export interface ProvisionDeps extends HttpDeps {
  log: (msg: string) => void;
}

interface OperationRef {
  name?: string;
  selfLink?: string;
}

/**
 * Provision the GCP resources required to host one Superfield environment.
 *
 * Idempotent: re-running with the same `projectId`+`env` detects existing
 * resources tagged `superfield-env=<env>` and returns the same `host`.
 */
export async function provision(
  opts: ProvisionOpts,
  deps: ProvisionDeps,
): Promise<ProvisionResult> {
  const names = resourceNames(opts.env);
  const labels = { "superfield-env": opts.env };

  if (opts.managedDb && !opts.mnemonic) {
    throw new Error("mnemonic is required when managedDb=true");
  }

  // ── 1. Generate ephemeral SSH key (always — we re-register on every run
  //       because the GCE metadata key list is the source of truth for
  //       fresh first-bootstrap access).
  const ephemeralKey = generateEphemeralSshKey();

  // ── 2. VPC network
  const networkUrl = `${COMPUTE_BASE}/projects/${opts.projectId}/global/networks/${names.network}`;
  await ensureResource({
    label: `VPC network "${names.network}"`,
    url: networkUrl,
    create: () =>
      googleJsonRequest<OperationRef>(
        `${COMPUTE_BASE}/projects/${opts.projectId}/global/networks`,
        {
          method: "POST",
          body: JSON.stringify({
            name: names.network,
            autoCreateSubnetworks: false,
          }),
        },
        deps,
      ),
    pollKind: "compute",
    deps,
  });

  // ── 3. Subnet
  const subnetUrl = `${COMPUTE_BASE}/projects/${opts.projectId}/regions/${opts.region}/subnetworks/${names.subnet}`;
  await ensureResource({
    label: `subnet "${names.subnet}"`,
    url: subnetUrl,
    create: () =>
      googleJsonRequest<OperationRef>(
        `${COMPUTE_BASE}/projects/${opts.projectId}/regions/${opts.region}/subnetworks`,
        {
          method: "POST",
          body: JSON.stringify({
            name: names.subnet,
            network: networkUrl,
            ipCidrRange: "10.10.0.0/24",
            region: opts.region,
          }),
        },
        deps,
      ),
    pollKind: "compute",
    deps,
  });

  // ── 4. SSH firewall rule (22/tcp from 0.0.0.0/0)
  const sshFwUrl = `${COMPUTE_BASE}/projects/${opts.projectId}/global/firewalls/${names.sshFirewall}`;
  await ensureResource({
    label: `SSH firewall rule "${names.sshFirewall}"`,
    url: sshFwUrl,
    create: () =>
      googleJsonRequest<OperationRef>(
        `${COMPUTE_BASE}/projects/${opts.projectId}/global/firewalls`,
        {
          method: "POST",
          body: JSON.stringify({
            name: names.sshFirewall,
            network: networkUrl,
            allowed: [{ IPProtocol: "tcp", ports: ["22"] }],
            sourceRanges: ["0.0.0.0/0"],
          }),
        },
        deps,
      ),
    pollKind: "compute",
    deps,
  });

  // ── 5. (managedDb only) PSA address + VPC peering + AlloyDB cluster + instance
  let databaseUrl: string | undefined;
  if (opts.managedDb) {
    databaseUrl = await provisionAlloyDb({
      opts,
      names,
      networkUrl,
      deps,
    });
  }

  // ── 6. Compute Engine VM
  const sshKeyEntry = sshKeysMetadata([
    { user: SSH_USER, publicKey: ephemeralKey.publicKeyOpenSsh },
    { user: SSH_USER, publicKey: opts.derivedDeployKeyPublicOpenSsh },
  ]);
  const vmUrl = `${COMPUTE_BASE}/projects/${opts.projectId}/zones/${opts.zone}/instances/${names.vm}`;
  const existing = await getResource<{
    networkInterfaces?: Array<{
      accessConfigs?: Array<{ natIP?: string }>;
    }>;
  }>(vmUrl, deps);
  if (existing) {
    deps.log(`VM "${names.vm}" already exists, reusing.`);
  } else {
    deps.log(`Creating VM "${names.vm}"…`);
    const op = await googleJsonRequest<OperationRef>(
      `${COMPUTE_BASE}/projects/${opts.projectId}/zones/${opts.zone}/instances`,
      {
        method: "POST",
        body: JSON.stringify({
          name: names.vm,
          machineType: `zones/${opts.zone}/machineTypes/${DEFAULT_MACHINE_TYPE}`,
          labels,
          networkInterfaces: [
            {
              network: networkUrl,
              subnetwork: subnetUrl,
              accessConfigs: [{ type: "ONE_TO_ONE_NAT", name: "External NAT" }],
            },
          ],
          disks: [
            {
              boot: true,
              autoDelete: true,
              initializeParams: {
                sourceImage:
                  "projects/debian-cloud/global/images/family/debian-12",
                diskSizeGb: String(DEFAULT_DISK_GB),
                diskType: `zones/${opts.zone}/diskTypes/pd-standard`,
              },
            },
          ],
          metadata: {
            items: [{ key: "ssh-keys", value: sshKeyEntry }],
          },
        }),
      },
      deps,
    );
    if (op?.selfLink) {
      await pollOperation(op.selfLink, deps);
    }
    deps.log(`VM "${names.vm}" created.`);
  }

  // ── 7. Resolve external IP (existing or freshly-created VM)
  const vm = await googleJsonRequest<{
    networkInterfaces?: Array<{
      accessConfigs?: Array<{ natIP?: string }>;
    }>;
  }>(vmUrl, {}, deps);
  const host = vm?.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP;
  if (!host) {
    throw new Error(`VM "${names.vm}" has no external IP`);
  }

  return {
    host,
    initialPrivateKeyPem: ephemeralKey.privateKeyPem,
    databaseUrl,
  };
}

// ── AlloyDB sub-flow ──────────────────────────────────────────────────────────

interface AlloyDbContext {
  opts: ProvisionOpts;
  names: ResourceNames;
  networkUrl: string;
  deps: ProvisionDeps;
}

async function provisionAlloyDb(ctx: AlloyDbContext): Promise<string> {
  const { opts, names, deps } = ctx;
  const password = derivePassword(
    Buffer.from(opts.mnemonic as Buffer), // copy so derivePassword can zero its own buffer
    opts.env,
    "db-password",
    32,
  );

  // PSA address
  const psaAddressUrl = `${COMPUTE_BASE}/projects/${opts.projectId}/global/addresses/${names.psaAddress}`;
  await ensureResource({
    label: `PSA address "${names.psaAddress}"`,
    url: psaAddressUrl,
    create: () =>
      googleJsonRequest<OperationRef>(
        `${COMPUTE_BASE}/projects/${opts.projectId}/global/addresses`,
        {
          method: "POST",
          body: JSON.stringify({
            name: names.psaAddress,
            addressType: "INTERNAL",
            purpose: "VPC_PEERING",
            network: ctx.networkUrl,
            prefixLength: 16,
          }),
        },
        deps,
      ),
    pollKind: "compute",
    deps,
  });

  // VPC peering via Service Networking
  const networkResourcePath = `projects/${opts.projectId}/global/networks/${names.network}`;
  const snConnectionsUrl = `${SERVICE_NET_BASE}/v1/services/servicenetworking.googleapis.com/connections`;
  const snListUrl = `${snConnectionsUrl}?network=${networkResourcePath}`;
  let peeringExists = false;
  try {
    const list = await googleJsonRequest<{ connections?: unknown[] }>(
      snListUrl,
      {},
      deps,
    );
    peeringExists = (list?.connections?.length ?? 0) > 0;
  } catch (e) {
    if (!(e instanceof Error && e.message.includes("404"))) throw e;
  }
  if (peeringExists) {
    deps.log(`VPC peering for "${names.network}" already exists, skipping.`);
  } else {
    deps.log(`Creating VPC peering for "${names.network}"…`);
    const op = await googleJsonRequest<OperationRef>(
      snConnectionsUrl,
      {
        method: "POST",
        body: JSON.stringify({
          network: networkResourcePath,
          reservedPeeringRanges: [names.psaAddress],
          service: "servicenetworking.googleapis.com",
        }),
      },
      deps,
    );
    if (op?.name) {
      const pollUrl = op.name.startsWith("http")
        ? op.name
        : `${SERVICE_NET_BASE}/v1/${op.name}`;
      await pollOperation(pollUrl, deps);
    } else if (op?.selfLink) {
      await pollOperation(op.selfLink, deps);
    }
    deps.log(`VPC peering created.`);
  }

  // AlloyDB cluster
  const clusterUrl = `${ALLOYDB_BASE}/projects/${opts.projectId}/locations/${opts.region}/clusters/${names.alloydbCluster}`;
  if (await getResource(clusterUrl, deps)) {
    deps.log(
      `AlloyDB cluster "${names.alloydbCluster}" already exists, skipping.`,
    );
  } else {
    deps.log(`Creating AlloyDB cluster "${names.alloydbCluster}"…`);
    const op = await googleJsonRequest<OperationRef>(
      `${ALLOYDB_BASE}/projects/${opts.projectId}/locations/${opts.region}/clusters?clusterId=${names.alloydbCluster}`,
      {
        method: "POST",
        body: JSON.stringify({
          databaseVersion: "POSTGRES_15",
          network: networkResourcePath,
          labels: { "superfield-env": opts.env },
          initialUser: { user: APP_DB_USER, password },
        }),
      },
      deps,
    );
    if (op?.name) {
      await pollOperation(`${ALLOYDB_BASE}/${op.name}`, deps);
    }
    deps.log(`AlloyDB cluster "${names.alloydbCluster}" created.`);
  }

  // AlloyDB primary instance
  const instanceUrl = `${ALLOYDB_BASE}/projects/${opts.projectId}/locations/${opts.region}/clusters/${names.alloydbCluster}/instances/${names.alloydbInstance}`;
  let instance = await getResource<{ ipAddress?: string }>(instanceUrl, deps);
  if (instance) {
    deps.log(
      `AlloyDB instance "${names.alloydbInstance}" already exists, skipping.`,
    );
  } else {
    deps.log(`Creating AlloyDB instance "${names.alloydbInstance}"…`);
    const op = await googleJsonRequest<OperationRef>(
      `${ALLOYDB_BASE}/projects/${opts.projectId}/locations/${opts.region}/clusters/${names.alloydbCluster}/instances?instanceId=${names.alloydbInstance}`,
      {
        method: "POST",
        body: JSON.stringify({
          instanceType: "PRIMARY",
          machineConfig: { cpuCount: ALLOYDB_CPU_COUNT },
          labels: { "superfield-env": opts.env },
        }),
      },
      deps,
    );
    if (op?.name) {
      await pollOperation(`${ALLOYDB_BASE}/${op.name}`, deps);
    }
    instance = await googleJsonRequest<{ ipAddress?: string }>(
      instanceUrl,
      {},
      deps,
    );
    deps.log(`AlloyDB instance "${names.alloydbInstance}" created.`);
  }

  const privateIp = instance?.ipAddress;
  if (!privateIp) {
    throw new Error(
      `AlloyDB instance "${names.alloydbInstance}" has no private IP`,
    );
  }
  return `postgresql://${APP_DB_USER}:${password}@${privateIp}:5432/${APP_DB_NAME}`;
}

// ── Resource naming + helpers ────────────────────────────────────────────────

export interface ResourceNames {
  network: string;
  subnet: string;
  sshFirewall: string;
  psaAddress: string;
  alloydbCluster: string;
  alloydbInstance: string;
  vm: string;
}

export function resourceNames(env: string): ResourceNames {
  const slug = sanitizeForGcpName(env);
  return {
    network: `superfield-${slug}-vpc`,
    subnet: `superfield-${slug}-subnet`,
    sshFirewall: `superfield-${slug}-ssh`,
    psaAddress: `superfield-${slug}-psa`,
    alloydbCluster: `superfield-${slug}-db`,
    alloydbInstance: `superfield-${slug}-db-primary`,
    vm: `superfield-${slug}-vm`,
  };
}

function sanitizeForGcpName(s: string): string {
  // GCP resource names: [a-z]([-a-z0-9]*[a-z0-9])?
  return s.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

function sshKeysMetadata(
  entries: Array<{ user: string; publicKey: string }>,
): string {
  return entries.map((e) => `${e.user}:${e.publicKey}`).join("\n");
}

interface EnsureArgs {
  label: string;
  url: string;
  create: () => Promise<OperationRef | null>;
  pollKind: "compute" | "alloydb" | "servicenet";
  deps: ProvisionDeps;
}

async function ensureResource(args: EnsureArgs): Promise<void> {
  const exists = await getResource(args.url, args.deps);
  if (exists) {
    args.deps.log(`${args.label} already exists, skipping.`);
    return;
  }
  args.deps.log(`Creating ${args.label}…`);
  const op = await args.create();
  if (op?.selfLink) {
    await pollOperation(op.selfLink, args.deps);
  } else if (op?.name) {
    if (args.pollKind === "alloydb") {
      await pollOperation(`${ALLOYDB_BASE}/${op.name}`, args.deps);
    } else if (args.pollKind === "servicenet") {
      await pollOperation(`${SERVICE_NET_BASE}/v1/${op.name}`, args.deps);
    }
  }
  args.deps.log(`${args.label} created.`);
}

async function getResource<T = unknown>(
  url: string,
  deps: HttpDeps,
): Promise<T | null> {
  try {
    return await googleJsonRequest<T>(url, {}, deps);
  } catch (e) {
    if (e instanceof Error && e.message.includes("404")) return null;
    throw e;
  }
}
