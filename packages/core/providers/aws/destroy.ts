/**
 * Symmetric tear-down for the AWS provider.
 *
 * Finds every resource tagged `superfield-env=<env>` and removes it. Any
 * call that raises a "not found" error is swallowed so `destroy` is
 * idempotent.
 */

import type { AwsClient } from "./clients.js";
import { buildDefaultClients } from "./clients.js";
import {
  deleteKeyPair,
  deleteSecurityGroup,
  describeSecurityGroupsByFilter,
  keyPairExists,
  listInstanceIdsByTag,
  terminateInstances,
} from "./ec2.js";
import { deleteDbInstance, deleteDbSubnetGroup } from "./rds.js";
import { resourceNames, SF_TAG_KEY } from "./types.js";

export interface DestroyOpts {
  region?: string;
  env: string;
}

export interface DestroyDeps {
  clients?: {
    ec2: AwsClient;
    rds: AwsClient;
  };
  log?: (m: string) => void;
}

export async function destroy(
  opts: DestroyOpts,
  deps: DestroyDeps = {},
): Promise<void> {
  const region = opts.region ?? "us-east-1";
  const log = deps.log ?? (() => {});
  const built = deps.clients
    ? deps.clients
    : (() => {
        const c = buildDefaultClients(region);
        return { ec2: c.ec2, rds: c.rds };
      })();
  const names = resourceNames(opts.env);

  // Terminate EC2 instances tagged for this env.
  const instanceIds = await listInstanceIdsByTag(built.ec2, opts.env);
  if (instanceIds.length > 0) {
    log(`Terminating instances: ${instanceIds.join(", ")}`);
    await terminateInstances(built.ec2, instanceIds);
  }

  // Delete RDS instance (skip final snapshot for the demo path).
  await tryAwait(deleteDbInstance(built.rds, names.dbInstanceIdentifier), log);

  // Delete DB subnet group.
  await tryAwait(deleteDbSubnetGroup(built.rds, names.dbSubnetGroupName), log);

  // Delete imported key pairs.
  for (const name of [names.ephemeralKeyPairName, names.derivedKeyPairName]) {
    const exists = await keyPairExists(built.ec2, name);
    if (exists) {
      await tryAwait(deleteKeyPair(built.ec2, name), log);
    }
  }

  // Delete tagged security groups (EC2 + RDS-side).
  const sgs = await describeSecurityGroupsByFilter(built.ec2, {
    [`tag:${SF_TAG_KEY}`]: opts.env,
  });
  for (const sg of sgs) {
    await tryAwait(deleteSecurityGroup(built.ec2, sg.groupId), log);
  }
}

async function tryAwait<T>(
  p: Promise<T>,
  log: (m: string) => void,
): Promise<T | undefined> {
  try {
    return await p;
  } catch (e) {
    log(`(non-fatal) ${(e as Error).message}`);
    return undefined;
  }
}
