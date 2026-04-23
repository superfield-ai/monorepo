/**
 * RDS Postgres lifecycle for the AWS provider.
 *
 * Idempotent helpers: each "ensure" looks for an existing instance / subnet
 * group by name and creates it only when missing. Tags use the same
 * `superfield-env=<env>` convention as the EC2 helpers so a single
 * `destroy` pass can find every resource.
 */

import {
  CreateDBInstanceCommand,
  CreateDBSubnetGroupCommand,
  DescribeDBInstancesCommand,
  DescribeDBSubnetGroupsCommand,
  type RDSClient,
} from "@aws-sdk/client-rds";
import {
  AuthorizeSecurityGroupIngressCommand,
  CreateSecurityGroupCommand,
  DescribeSecurityGroupsCommand,
  type EC2Client,
} from "@aws-sdk/client-ec2";

import { SF_TAG_KEY } from "./types.js";

export const RDS_SG_DESCRIPTION = "superfield-rds";

/** Ensure a per-env RDS-side security group that allows 5432 from the EC2 SG. */
export async function ensureRdsSecurityGroup(
  ec2: EC2Client,
  rdsSgName: string,
  vpcId: string,
  env: string,
  ec2SgId: string,
): Promise<string> {
  const existing = await ec2.send(
    new DescribeSecurityGroupsCommand({
      Filters: [
        { Name: "group-name", Values: [rdsSgName] },
        { Name: "vpc-id", Values: [vpcId] },
      ],
    }),
  );
  if (existing.SecurityGroups && existing.SecurityGroups.length > 0) {
    const sg = existing.SecurityGroups[0];
    if (!sg?.GroupId) throw new Error("rds security group has no GroupId");
    return sg.GroupId;
  }
  const created = await ec2.send(
    new CreateSecurityGroupCommand({
      GroupName: rdsSgName,
      Description: `superfield ${env} RDS ingress`,
      VpcId: vpcId,
      TagSpecifications: [
        {
          ResourceType: "security-group",
          Tags: [{ Key: SF_TAG_KEY, Value: env }],
        },
      ],
    }),
  );
  const groupId = created.GroupId;
  if (!groupId) throw new Error("CreateSecurityGroup returned no GroupId");
  await ec2.send(
    new AuthorizeSecurityGroupIngressCommand({
      GroupId: groupId,
      IpPermissions: [
        {
          IpProtocol: "tcp",
          FromPort: 5432,
          ToPort: 5432,
          UserIdGroupPairs: [
            { GroupId: ec2SgId, Description: RDS_SG_DESCRIPTION },
          ],
        },
      ],
    }),
  );
  return groupId;
}

/**
 * Ensure a DB subnet group exists covering ≥2 distinct AZs (RDS requirement
 * even for single-AZ instances).
 */
export async function ensureDbSubnetGroup(
  rds: RDSClient,
  subnetGroupName: string,
  subnetIds: string[],
  env: string,
): Promise<void> {
  try {
    const existing = await rds.send(
      new DescribeDBSubnetGroupsCommand({ DBSubnetGroupName: subnetGroupName }),
    );
    if (existing.DBSubnetGroups && existing.DBSubnetGroups.length > 0) {
      return;
    }
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
  if (subnetIds.length < 2) {
    throw new Error(
      `RDS subnet group needs ≥2 subnets in distinct AZs; got ${subnetIds.length}`,
    );
  }
  await rds.send(
    new CreateDBSubnetGroupCommand({
      DBSubnetGroupName: subnetGroupName,
      DBSubnetGroupDescription: `superfield ${env} default-VPC subnets`,
      SubnetIds: subnetIds,
      Tags: [{ Key: SF_TAG_KEY, Value: env }],
    }),
  );
}

export interface RdsEndpoint {
  address: string;
  port: number;
}

/** Look up an existing RDS instance by id. Returns undefined if absent. */
export async function findDbInstance(
  rds: RDSClient,
  identifier: string,
): Promise<RdsEndpoint | undefined> {
  try {
    const out = await rds.send(
      new DescribeDBInstancesCommand({ DBInstanceIdentifier: identifier }),
    );
    const inst = out.DBInstances?.[0];
    if (!inst?.Endpoint?.Address || !inst.Endpoint.Port) return undefined;
    return { address: inst.Endpoint.Address, port: inst.Endpoint.Port };
  } catch (e) {
    if (isNotFound(e)) return undefined;
    throw e;
  }
}

/** Create the per-env Postgres instance. */
export async function createDbInstance(
  rds: RDSClient,
  args: {
    identifier: string;
    subnetGroupName: string;
    securityGroupId: string;
    masterUsername: string;
    masterPassword: string;
    env: string;
  },
): Promise<void> {
  await rds.send(
    new CreateDBInstanceCommand({
      DBInstanceIdentifier: args.identifier,
      DBInstanceClass: "db.t3.micro",
      Engine: "postgres",
      EngineVersion: "16",
      AllocatedStorage: 20,
      StorageType: "gp3",
      MultiAZ: false,
      PubliclyAccessible: false,
      DBSubnetGroupName: args.subnetGroupName,
      VpcSecurityGroupIds: [args.securityGroupId],
      MasterUsername: args.masterUsername,
      MasterUserPassword: args.masterPassword,
      DBName: "app",
      Tags: [{ Key: SF_TAG_KEY, Value: args.env }],
    }),
  );
}

/** Poll until the RDS instance is `available` and exposes an endpoint. */
export async function waitForDbAvailable(
  rds: RDSClient,
  identifier: string,
  opts: {
    timeoutMs: number;
    intervalMs: number;
    sleep: (ms: number) => Promise<void>;
  },
): Promise<RdsEndpoint> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const out = await rds.send(
      new DescribeDBInstancesCommand({ DBInstanceIdentifier: identifier }),
    );
    const inst = out.DBInstances?.[0];
    if (
      inst?.DBInstanceStatus === "available" &&
      inst.Endpoint?.Address &&
      inst.Endpoint.Port
    ) {
      return { address: inst.Endpoint.Address, port: inst.Endpoint.Port };
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for RDS ${identifier} to be available`,
      );
    }
    await opts.sleep(opts.intervalMs);
  }
}

function isNotFound(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const name = (e as { name?: string }).name;
  return (
    name === "DBSubnetGroupNotFoundFault" ||
    name === "DBInstanceNotFoundFault" ||
    name === "DBInstanceNotFound" ||
    name === "DBSubnetGroupNotFound"
  );
}
