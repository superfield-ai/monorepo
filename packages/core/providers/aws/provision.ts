/**
 * AWS provider: provision an EC2 instance (and optionally an RDS Postgres)
 * for one Superfield environment.
 *
 * Public surface mirrors the GCP and DigitalOcean helpers: every vendor
 * returns `{ host, initialPrivateKeyPem, databaseUrl? }` so the downstream
 * deploy code stays vendor-agnostic.
 *
 * # Test seam
 *
 * The optional second argument `{ clients?: { ec2, rds, ssm } }` lets unit
 * tests inject SDK client doubles. We deliberately do NOT use a mocking
 * library — repo policy forbids `vi.fn`, `vi.mock`, `vi.spyOn`,
 * `vi.stubGlobal`, and `aws-sdk-client-mock`. Test doubles are real
 * objects whose `.send(command)` method dispatches to recorded fixtures
 * (see `tests/unit/aws/`).
 *
 * # Idempotency
 *
 * Every resource is tagged `superfield-env=<env>`. The orchestrator looks
 * up resources by tag (or canonical name, for default-VPC objects) before
 * creating them, so re-running `provision` against the same env converges
 * instead of doubling resources.
 */

import { derivePassword } from "../../secrets/index.js";
import { buildDefaultClients } from "./clients.js";
import {
  ensureImportedKeyPair,
  ensureSecurityGroup,
  findInstanceByTag,
  getDefaultVpcId,
  listVpcSubnets,
  runInstance,
  waitForInstanceHost,
} from "./ec2.js";
import { generateEphemeralEd25519 } from "./keys.js";
import {
  createDbInstance,
  ensureDbSubnetGroup,
  ensureRdsSecurityGroup,
  findDbInstance,
  waitForDbAvailable,
} from "./rds.js";
import { resolveUbuntuNobleAmi } from "./ssm.js";
import {
  type ProvisionDeps,
  type ProvisionOpts,
  type ProvisionResult,
  resourceNames,
} from "./types.js";

const DEFAULT_REGION = "us-east-1";
const DEFAULT_INSTANCE_TYPE = "t3.small";
const DEFAULT_INSTANCE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_DB_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 5 * 1000;

export async function provision(
  opts: ProvisionOpts,
  deps: ProvisionDeps = {},
): Promise<ProvisionResult> {
  if (!opts.env || opts.env.includes("/")) {
    throw new Error("env must be a non-empty string with no '/'");
  }
  if (opts.managedDb && !opts.mnemonic) {
    throw new Error("managedDb=true requires a mnemonic Buffer");
  }

  const region = opts.region ?? DEFAULT_REGION;
  const sleep = deps.sleep ?? defaultSleep;
  const log = deps.log ?? noopLog;
  const clients = deps.clients ?? buildDefaultClients(region);
  const names = resourceNames(opts.env);

  log(`Resolving Ubuntu 24.04 AMI for ${region}…`);
  const amiId = await resolveUbuntuNobleAmi(clients.ssm);

  log("Resolving default VPC…");
  const vpcId = await getDefaultVpcId(clients.ec2);
  const subnets = await listVpcSubnets(clients.ec2, vpcId);

  log(`Ensuring security group ${names.securityGroupName}…`);
  const ec2SgId = await ensureSecurityGroup(
    clients.ec2,
    names.securityGroupName,
    vpcId,
    opts.env,
  );

  // The ephemeral key pair returns the private material to the caller.
  // It's only generated when the instance does not yet exist; on a re-run
  // the existing instance's private key is unrecoverable, so we keep the
  // contract honest: the returned `initialPrivateKeyPem` is meaningful
  // only on first provision. On idempotent re-runs we still generate +
  // import a fresh ephemeral key (the caller can opt to ignore it),
  // because the alternative is to return an empty string and silently
  // change the contract.
  const ephemeral = generateEphemeralEd25519();
  log(`Importing ephemeral key pair ${names.ephemeralKeyPairName}…`);
  await ensureImportedKeyPair(
    clients.ec2,
    names.ephemeralKeyPairName,
    ephemeral.publicKeyOpenSsh,
    opts.env,
  );

  log(`Importing derived deploy key ${names.derivedKeyPairName}…`);
  await ensureImportedKeyPair(
    clients.ec2,
    names.derivedKeyPairName,
    opts.derivedDeployKeyPublicOpenSsh,
    opts.env,
  );

  log("Looking for existing tagged instance…");
  let host: string | undefined;
  const existing = await findInstanceByTag(clients.ec2, opts.env);
  if (existing) {
    log(`Reusing instance ${existing.instanceId} (state=${existing.state}).`);
    host =
      existing.publicDns ||
      existing.publicIp ||
      (await waitForInstanceHost(clients.ec2, existing.instanceId, {
        timeoutMs: DEFAULT_INSTANCE_TIMEOUT_MS,
        intervalMs: DEFAULT_POLL_INTERVAL_MS,
        sleep,
      }));
  } else {
    log(`Launching ${DEFAULT_INSTANCE_TYPE} from ${amiId}…`);
    const id = await runInstance(clients.ec2, {
      amiId,
      instanceType: DEFAULT_INSTANCE_TYPE,
      keyName: names.ephemeralKeyPairName,
      securityGroupId: ec2SgId,
      env: opts.env,
      nameTag: names.instanceNameTag,
    });
    host = await waitForInstanceHost(clients.ec2, id, {
      timeoutMs: DEFAULT_INSTANCE_TIMEOUT_MS,
      intervalMs: DEFAULT_POLL_INTERVAL_MS,
      sleep,
    });
  }

  let databaseUrl: string | undefined;
  if (opts.managedDb) {
    databaseUrl = await provisionDb({
      ec2: clients.ec2,
      rds: clients.rds,
      vpcId,
      subnetIds: distinctAzSubnetIds(subnets),
      ec2SgId,
      env: opts.env,
      mnemonic: opts.mnemonic as Buffer,
      sleep,
      log,
      identifier: names.dbInstanceIdentifier,
      subnetGroupName: names.dbSubnetGroupName,
    });
  }

  return {
    host,
    initialPrivateKeyPem: ephemeral.privateKeyPem,
    ...(databaseUrl ? { databaseUrl } : {}),
  };
}

function distinctAzSubnetIds(
  subnets: Array<{ subnetId: string; az: string }>,
): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const s of subnets) {
    if (seen.has(s.az)) continue;
    seen.add(s.az);
    ids.push(s.subnetId);
  }
  return ids;
}

interface ProvisionDbArgs {
  ec2: import("./clients.js").AwsClient;
  rds: import("./clients.js").AwsClient;
  vpcId: string;
  subnetIds: string[];
  ec2SgId: string;
  env: string;
  mnemonic: Buffer;
  sleep: (ms: number) => Promise<void>;
  log: (m: string) => void;
  identifier: string;
  subnetGroupName: string;
}

async function provisionDb(args: ProvisionDbArgs): Promise<string> {
  const rdsSgName = `superfield-rds-${args.env}`;
  args.log(`Ensuring RDS security group ${rdsSgName}…`);
  const rdsSgId = await ensureRdsSecurityGroup(
    args.ec2,
    rdsSgName,
    args.vpcId,
    args.env,
    args.ec2SgId,
  );

  args.log(`Ensuring DB subnet group ${args.subnetGroupName}…`);
  await ensureDbSubnetGroup(
    args.rds,
    args.subnetGroupName,
    args.subnetIds,
    args.env,
  );

  // `derivePassword` zeroes the mnemonic Buffer in its `finally`, so we
  // must compute the password before any other code touches `mnemonic`.
  const password = derivePassword(args.mnemonic, args.env, "db-password", 32);

  args.log("Looking for existing RDS instance…");
  let endpoint = await findDbInstance(args.rds, args.identifier);
  if (!endpoint) {
    args.log(`Creating RDS instance ${args.identifier}…`);
    await createDbInstance(args.rds, {
      identifier: args.identifier,
      subnetGroupName: args.subnetGroupName,
      securityGroupId: rdsSgId,
      masterUsername: "app",
      masterPassword: password,
      env: args.env,
    });
    endpoint = await waitForDbAvailable(args.rds, args.identifier, {
      timeoutMs: DEFAULT_DB_TIMEOUT_MS,
      intervalMs: DEFAULT_POLL_INTERVAL_MS,
      sleep: args.sleep,
    });
  }
  return `postgresql://app:${password}@${endpoint.address}:${endpoint.port}/app`;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function noopLog(_m: string): void {
  // intentionally empty
}
