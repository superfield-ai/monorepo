/**
 * Symmetric tear-down for the AWS provider.
 *
 * Finds every resource tagged `superfield-env=<env>` and removes it. Any
 * call that raises a "not found" error is swallowed so `destroy` is
 * idempotent.
 */

import {
  DeleteKeyPairCommand,
  DeleteSecurityGroupCommand,
  DescribeInstancesCommand,
  DescribeKeyPairsCommand,
  DescribeSecurityGroupsCommand,
  type EC2Client,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import {
  DeleteDBInstanceCommand,
  DeleteDBSubnetGroupCommand,
  DescribeDBInstancesCommand,
  type RDSClient,
} from "@aws-sdk/client-rds";

import { buildDefaultClients } from "./clients.js";
import { resourceNames, SF_TAG_KEY } from "./types.js";

export interface DestroyOpts {
  region?: string;
  env: string;
}

export interface DestroyDeps {
  clients?: {
    ec2: EC2Client;
    rds: RDSClient;
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
  const inst = await built.ec2.send(
    new DescribeInstancesCommand({
      Filters: [{ Name: `tag:${SF_TAG_KEY}`, Values: [opts.env] }],
    }),
  );
  const instanceIds: string[] = [];
  for (const r of inst.Reservations ?? []) {
    for (const i of r.Instances ?? []) {
      if (i.InstanceId && i.State?.Name !== "terminated") {
        instanceIds.push(i.InstanceId);
      }
    }
  }
  if (instanceIds.length > 0) {
    log(`Terminating instances: ${instanceIds.join(", ")}`);
    await built.ec2.send(
      new TerminateInstancesCommand({ InstanceIds: instanceIds }),
    );
  }

  // Delete RDS instance (skip final snapshot for the demo path).
  await tryAwait(
    built.rds.send(
      new DeleteDBInstanceCommand({
        DBInstanceIdentifier: names.dbInstanceIdentifier,
        SkipFinalSnapshot: true,
        DeleteAutomatedBackups: true,
      }),
    ),
    log,
  );

  // Wait briefly for RDS to release the subnet group, then delete it.
  await tryAwait(
    built.rds.send(
      new DescribeDBInstancesCommand({
        DBInstanceIdentifier: names.dbInstanceIdentifier,
      }),
    ),
    log,
  );
  await tryAwait(
    built.rds.send(
      new DeleteDBSubnetGroupCommand({
        DBSubnetGroupName: names.dbSubnetGroupName,
      }),
    ),
    log,
  );

  // Delete imported key pairs.
  for (const name of [names.ephemeralKeyPairName, names.derivedKeyPairName]) {
    const kp = await built.ec2.send(
      new DescribeKeyPairsCommand({
        Filters: [{ Name: "key-name", Values: [name] }],
      }),
    );
    if (kp.KeyPairs && kp.KeyPairs.length > 0) {
      await tryAwait(
        built.ec2.send(new DeleteKeyPairCommand({ KeyName: name })),
        log,
      );
    }
  }

  // Delete tagged security groups (EC2 + RDS-side).
  const sgs = await built.ec2.send(
    new DescribeSecurityGroupsCommand({
      Filters: [{ Name: `tag:${SF_TAG_KEY}`, Values: [opts.env] }],
    }),
  );
  for (const sg of sgs.SecurityGroups ?? []) {
    if (!sg.GroupId) continue;
    await tryAwait(
      built.ec2.send(new DeleteSecurityGroupCommand({ GroupId: sg.GroupId })),
      log,
    );
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
