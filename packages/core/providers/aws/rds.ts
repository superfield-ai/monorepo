/**
 * RDS Postgres lifecycle for the AWS provider.
 *
 * Idempotent helpers: each "ensure" looks for an existing instance / subnet
 * group by name and creates it only when missing. Tags use the same
 * `superfield-env=<env>` convention as the EC2 helpers so a single
 * `destroy` pass can find every resource.
 *
 * Uses plain fetch() + SigV4 against the RDS Query API.
 * API version: 2014-10-31.
 */

import type { AwsClient } from "./clients.js";
import {
  authorizeIngressFromSg,
  createSecurityGroup,
  describeSecurityGroupsByFilter,
} from "./ec2.js";
import { SF_TAG_KEY } from "./types.js";

const RDS_VERSION = "2014-10-31";

export const RDS_SG_DESCRIPTION = "superfield-rds";

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

function xmlText(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "s");
  return re.exec(xml)?.[1] ?? undefined;
}

function xmlBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "g");
  const results: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    results.push(m[1] as string);
  }
  return results;
}

function isNotFoundError(text: string): boolean {
  return (
    text.includes("DBSubnetGroupNotFoundFault") ||
    text.includes("DBInstanceNotFoundFault") ||
    text.includes("DBInstanceNotFound") ||
    text.includes("DBSubnetGroupNotFound")
  );
}

// ---------------------------------------------------------------------------
// EC2 security group helpers (RDS uses EC2 SGs)
// ---------------------------------------------------------------------------

/** Ensure a per-env RDS-side security group that allows 5432 from the EC2 SG. */
export async function ensureRdsSecurityGroup(
  ec2: AwsClient,
  rdsSgName: string,
  vpcId: string,
  env: string,
  ec2SgId: string,
): Promise<string> {
  const existing = await describeSecurityGroupsByFilter(ec2, {
    "group-name": rdsSgName,
    "vpc-id": vpcId,
  });
  if (existing.length > 0) {
    const groupId = existing[0]?.groupId;
    if (!groupId) throw new Error("rds security group has no groupId");
    return groupId;
  }

  const groupId = await createSecurityGroup(ec2, {
    name: rdsSgName,
    description: `superfield ${env} RDS ingress`,
    vpcId,
    env,
  });

  await authorizeIngressFromSg(
    ec2,
    groupId,
    5432,
    5432,
    ec2SgId,
    RDS_SG_DESCRIPTION,
  );
  return groupId;
}

// ---------------------------------------------------------------------------
// RDS DB subnet group
// ---------------------------------------------------------------------------

/**
 * Ensure a DB subnet group exists covering ≥2 distinct AZs (RDS requirement
 * even for single-AZ instances).
 */
export async function ensureDbSubnetGroup(
  rds: AwsClient,
  subnetGroupName: string,
  subnetIds: string[],
  env: string,
): Promise<void> {
  // Check if it already exists.
  try {
    const xml = await rds.query({
      Action: "DescribeDBSubnetGroups",
      Version: RDS_VERSION,
      DBSubnetGroupName: subnetGroupName,
    });
    if (xml.includes("<DBSubnetGroupName>")) return;
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (!isNotFoundError(msg)) throw e;
  }

  if (subnetIds.length < 2) {
    throw new Error(
      `RDS subnet group needs ≥2 subnets in distinct AZs; got ${subnetIds.length}`,
    );
  }

  const params: Record<string, string> = {
    Action: "CreateDBSubnetGroup",
    Version: RDS_VERSION,
    DBSubnetGroupName: subnetGroupName,
    DBSubnetGroupDescription: `superfield ${env} default-VPC subnets`,
    "Tag.1.Key": SF_TAG_KEY,
    "Tag.1.Value": env,
  };
  subnetIds.forEach((id, i) => {
    params[`SubnetIds.member.${i + 1}`] = id;
  });
  await rds.query(params);
}

// ---------------------------------------------------------------------------
// RDS DB instance
// ---------------------------------------------------------------------------

export interface RdsEndpoint {
  address: string;
  port: number;
}

/** Look up an existing RDS instance by id. Returns undefined if absent. */
export async function findDbInstance(
  rds: AwsClient,
  identifier: string,
): Promise<RdsEndpoint | undefined> {
  try {
    const xml = await rds.query({
      Action: "DescribeDBInstances",
      Version: RDS_VERSION,
      DBInstanceIdentifier: identifier,
    });
    const address = xmlText(xml, "Address");
    const portStr = xmlText(xml, "Port");
    if (!address || !portStr) return undefined;
    return { address, port: parseInt(portStr, 10) };
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (isNotFoundError(msg)) return undefined;
    throw e;
  }
}

/** Create the per-env Postgres instance. */
export async function createDbInstance(
  rds: AwsClient,
  args: {
    identifier: string;
    subnetGroupName: string;
    securityGroupId: string;
    masterUsername: string;
    masterPassword: string;
    env: string;
  },
): Promise<void> {
  await rds.query({
    Action: "CreateDBInstance",
    Version: RDS_VERSION,
    DBInstanceIdentifier: args.identifier,
    DBInstanceClass: "db.t3.micro",
    Engine: "postgres",
    EngineVersion: "16",
    AllocatedStorage: "20",
    StorageType: "gp3",
    MultiAZ: "false",
    PubliclyAccessible: "false",
    DBSubnetGroupName: args.subnetGroupName,
    "VpcSecurityGroupIds.member.1": args.securityGroupId,
    MasterUsername: args.masterUsername,
    MasterUserPassword: args.masterPassword,
    DBName: "app",
    "Tag.1.Key": SF_TAG_KEY,
    "Tag.1.Value": args.env,
  });
}

/** Poll until the RDS instance is `available` and exposes an endpoint. */
export async function waitForDbAvailable(
  rds: AwsClient,
  identifier: string,
  opts: {
    timeoutMs: number;
    intervalMs: number;
    sleep: (ms: number) => Promise<void>;
  },
): Promise<RdsEndpoint> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    try {
      const xml = await rds.query({
        Action: "DescribeDBInstances",
        Version: RDS_VERSION,
        DBInstanceIdentifier: identifier,
      });
      const blocks = xmlBlocks(xml, "DBInstance");
      for (const block of blocks) {
        const status = xmlText(block, "DBInstanceStatus");
        const address = xmlText(block, "Address");
        const portStr = xmlText(block, "Port");
        if (status === "available" && address && portStr) {
          return { address, port: parseInt(portStr, 10) };
        }
      }
    } catch (e) {
      // swallow transient errors during polling
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for RDS ${identifier} to be available`,
      );
    }
    await opts.sleep(opts.intervalMs);
  }
}

/** Delete an RDS instance (skip final snapshot). */
export async function deleteDbInstance(
  rds: AwsClient,
  identifier: string,
): Promise<void> {
  await rds.query({
    Action: "DeleteDBInstance",
    Version: RDS_VERSION,
    DBInstanceIdentifier: identifier,
    SkipFinalSnapshot: "true",
    DeleteAutomatedBackups: "true",
  });
}

/** Delete an RDS DB subnet group. */
export async function deleteDbSubnetGroup(
  rds: AwsClient,
  subnetGroupName: string,
): Promise<void> {
  await rds.query({
    Action: "DeleteDBSubnetGroup",
    Version: RDS_VERSION,
    DBSubnetGroupName: subnetGroupName,
  });
}
