/**
 * EC2 resource lifecycle for the AWS provider.
 *
 * Idempotent helpers for the default VPC, dedicated security group, two key
 * pairs (ephemeral + derived), and the EC2 instance itself. Each "ensure"
 * function looks the resource up by tag (or canonical name for default-VPC
 * objects) and creates it only when missing.
 *
 * Uses plain fetch() + SigV4 against the EC2 Query API
 * (https://ec2.<region>.amazonaws.com/, Content-Type: application/x-www-form-urlencoded).
 * API version: 2016-11-15.
 */

import type { AwsClient } from "./clients.js";
import { SF_TAG_KEY } from "./types.js";

const EC2_VERSION = "2016-11-15";

export const SSH_INGRESS_DESCRIPTION = "superfield-ssh";

// ---------------------------------------------------------------------------
// XML helpers — thin extractions; no external XML library needed.
// ---------------------------------------------------------------------------

/** Extract the text of the first matching tag (shallow, not namespace-aware). */
function xmlText(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "s");
  return re.exec(xml)?.[1] ?? undefined;
}

/**
 * Extract repeated blocks between open/close tags (non-nested, returns inner
 * XML of each occurrence).
 */
function xmlBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "g");
  const results: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    results.push(m[1] as string);
  }
  return results;
}

// ---------------------------------------------------------------------------
// EC2 API calls
// ---------------------------------------------------------------------------

/** Look up the account's default VPC. Throws if none exists in this region. */
export async function getDefaultVpcId(ec2: AwsClient): Promise<string> {
  const xml = await ec2.query({
    Action: "DescribeVpcs",
    Version: EC2_VERSION,
    "Filter.1.Name": "isDefault",
    "Filter.1.Value.1": "true",
  });
  const vpcId = xmlText(xml, "vpcId");
  if (!vpcId) {
    throw new Error(
      "no default VPC in this region; create one with `aws ec2 create-default-vpc`",
    );
  }
  return vpcId;
}

/** List subnet IDs (with their AZ) belonging to the supplied VPC. */
export async function listVpcSubnets(
  ec2: AwsClient,
  vpcId: string,
): Promise<Array<{ subnetId: string; az: string }>> {
  const xml = await ec2.query({
    Action: "DescribeSubnets",
    Version: EC2_VERSION,
    "Filter.1.Name": "vpc-id",
    "Filter.1.Value.1": vpcId,
  });
  const blocks = xmlBlocks(xml, "item");
  const results: Array<{ subnetId: string; az: string }> = [];
  for (const block of blocks) {
    const subnetId = xmlText(block, "subnetId");
    const az = xmlText(block, "availabilityZone");
    if (subnetId && az) results.push({ subnetId, az });
  }
  return results;
}

/**
 * Ensure the per-env security group exists and allows TCP/22 from anywhere.
 * Returns the resolved group id. Idempotent: a second call finds the
 * group by name + vpc and returns its id without re-creating it.
 */
export async function ensureSecurityGroup(
  ec2: AwsClient,
  name: string,
  vpcId: string,
  env: string,
): Promise<string> {
  const descXml = await ec2.query({
    Action: "DescribeSecurityGroups",
    Version: EC2_VERSION,
    "Filter.1.Name": "group-name",
    "Filter.1.Value.1": name,
    "Filter.2.Name": "vpc-id",
    "Filter.2.Value.1": vpcId,
  });
  const existing = xmlText(descXml, "groupId");
  if (existing) return existing;

  const createXml = await ec2.query({
    Action: "CreateSecurityGroup",
    Version: EC2_VERSION,
    GroupName: name,
    Description: `superfield ${env} SSH ingress`,
    VpcId: vpcId,
    "TagSpecification.1.ResourceType": "security-group",
    "TagSpecification.1.Tag.1.Key": SF_TAG_KEY,
    "TagSpecification.1.Tag.1.Value": env,
  });
  const groupId = xmlText(createXml, "groupId");
  if (!groupId) throw new Error("CreateSecurityGroup returned no groupId");

  await ec2.query({
    Action: "AuthorizeSecurityGroupIngress",
    Version: EC2_VERSION,
    GroupId: groupId,
    "IpPermissions.1.IpProtocol": "tcp",
    "IpPermissions.1.FromPort": "22",
    "IpPermissions.1.ToPort": "22",
    "IpPermissions.1.IpRanges.1.CidrIp": "0.0.0.0/0",
    "IpPermissions.1.IpRanges.1.Description": SSH_INGRESS_DESCRIPTION,
  });
  return groupId;
}

/**
 * Ensure a key pair with `name` is registered. If it exists, this is a
 * no-op. If not, the supplied OpenSSH public key is imported.
 */
export async function ensureImportedKeyPair(
  ec2: AwsClient,
  name: string,
  publicKeyOpenSsh: string,
  env: string,
): Promise<void> {
  const descXml = await ec2.query({
    Action: "DescribeKeyPairs",
    Version: EC2_VERSION,
    "Filter.1.Name": "key-name",
    "Filter.1.Value.1": name,
  });
  if (xmlText(descXml, "keyName")) return;

  await ec2.query({
    Action: "ImportKeyPair",
    Version: EC2_VERSION,
    KeyName: name,
    PublicKeyMaterial: Buffer.from(publicKeyOpenSsh, "utf8").toString("base64"),
    "TagSpecification.1.ResourceType": "key-pair",
    "TagSpecification.1.Tag.1.Key": SF_TAG_KEY,
    "TagSpecification.1.Tag.1.Value": env,
  });
}

export interface FoundInstance {
  instanceId: string;
  publicDns: string | undefined;
  publicIp: string | undefined;
  state: string | undefined;
}

/** Look up an existing tagged instance for this env. */
export async function findInstanceByTag(
  ec2: AwsClient,
  env: string,
): Promise<FoundInstance | undefined> {
  const xml = await ec2.query({
    Action: "DescribeInstances",
    Version: EC2_VERSION,
    [`Filter.1.Name`]: `tag:${SF_TAG_KEY}`,
    "Filter.1.Value.1": env,
    "Filter.2.Name": "instance-state-name",
    "Filter.2.Value.1": "pending",
    "Filter.2.Value.2": "running",
    "Filter.2.Value.3": "stopping",
    "Filter.2.Value.4": "stopped",
  });

  const items = xmlBlocks(xml, "item");
  for (const item of items) {
    const instanceId = xmlText(item, "instanceId");
    if (!instanceId) continue;
    return {
      instanceId,
      publicDns: xmlText(item, "dnsName") || undefined,
      publicIp: xmlText(item, "ipAddress") || undefined,
      state: xmlText(item, "name"),
    };
  }
  return undefined;
}

/**
 * Launch a new EC2 instance with the supplied AMI, key pair, and SG.
 * Tags the instance with `superfield-env=<env>` so future runs find it.
 */
export async function runInstance(
  ec2: AwsClient,
  args: {
    amiId: string;
    instanceType: string;
    keyName: string;
    securityGroupId: string;
    env: string;
    nameTag: string;
  },
): Promise<string> {
  const xml = await ec2.query({
    Action: "RunInstances",
    Version: EC2_VERSION,
    ImageId: args.amiId,
    InstanceType: args.instanceType,
    KeyName: args.keyName,
    "SecurityGroupId.1": args.securityGroupId,
    MinCount: "1",
    MaxCount: "1",
    "TagSpecification.1.ResourceType": "instance",
    "TagSpecification.1.Tag.1.Key": SF_TAG_KEY,
    "TagSpecification.1.Tag.1.Value": args.env,
    "TagSpecification.1.Tag.2.Key": "Name",
    "TagSpecification.1.Tag.2.Value": args.nameTag,
    "TagSpecification.2.ResourceType": "volume",
    "TagSpecification.2.Tag.1.Key": SF_TAG_KEY,
    "TagSpecification.2.Tag.1.Value": args.env,
  });
  const id = xmlText(xml, "instanceId");
  if (!id) throw new Error("RunInstances returned no instanceId");
  return id;
}

/** Re-tag an existing resource (used to upgrade an untagged item). */
export async function tagResource(
  ec2: AwsClient,
  resourceId: string,
  env: string,
): Promise<void> {
  await ec2.query({
    Action: "CreateTags",
    Version: EC2_VERSION,
    "ResourceId.1": resourceId,
    "Tag.1.Key": SF_TAG_KEY,
    "Tag.1.Value": env,
  });
}

/**
 * Poll `DescribeInstances` until the instance has a public DNS name (or
 * IP) and is in `running` state, up to `timeoutMs`. Returns the resolved
 * host string suitable for SSH.
 */
export async function waitForInstanceHost(
  ec2: AwsClient,
  instanceId: string,
  opts: {
    timeoutMs: number;
    intervalMs: number;
    sleep: (ms: number) => Promise<void>;
  },
): Promise<string> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const xml = await ec2.query({
      Action: "DescribeInstances",
      Version: EC2_VERSION,
      "InstanceId.1": instanceId,
    });
    const items = xmlBlocks(xml, "item");
    for (const item of items) {
      const instId = xmlText(item, "instanceId");
      if (instId !== instanceId) continue;
      const state = xmlText(item, "name");
      const host = xmlText(item, "dnsName") || xmlText(item, "ipAddress");
      if (state === "running" && host) return host;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for instance ${instanceId} to expose a public host`,
      );
    }
    await opts.sleep(opts.intervalMs);
  }
}

// ---------------------------------------------------------------------------
// Helpers also used in rds.ts / destroy.ts
// ---------------------------------------------------------------------------

/**
 * List security group IDs matching a set of filters.
 * Returns array of { groupId, groupName }.
 */
export async function describeSecurityGroupsByFilter(
  ec2: AwsClient,
  filters: Record<string, string>,
): Promise<Array<{ groupId: string; groupName: string }>> {
  const params: Record<string, string> = {
    Action: "DescribeSecurityGroups",
    Version: EC2_VERSION,
  };
  let i = 1;
  for (const [name, value] of Object.entries(filters)) {
    params[`Filter.${i}.Name`] = name;
    params[`Filter.${i}.Value.1`] = value;
    i++;
  }
  const xml = await ec2.query(params);
  const blocks = xmlBlocks(xml, "item");
  const results: Array<{ groupId: string; groupName: string }> = [];
  for (const block of blocks) {
    const groupId = xmlText(block, "groupId");
    const groupName = xmlText(block, "groupName");
    if (groupId && groupName) results.push({ groupId, groupName });
  }
  return results;
}

/** Create a security group; returns its groupId. */
export async function createSecurityGroup(
  ec2: AwsClient,
  args: {
    name: string;
    description: string;
    vpcId: string;
    env: string;
  },
): Promise<string> {
  const xml = await ec2.query({
    Action: "CreateSecurityGroup",
    Version: EC2_VERSION,
    GroupName: args.name,
    Description: args.description,
    VpcId: args.vpcId,
    "TagSpecification.1.ResourceType": "security-group",
    "TagSpecification.1.Tag.1.Key": SF_TAG_KEY,
    "TagSpecification.1.Tag.1.Value": args.env,
  });
  const groupId = xmlText(xml, "groupId");
  if (!groupId) throw new Error("CreateSecurityGroup returned no groupId");
  return groupId;
}

/** Authorize TCP ingress from an EC2 security group (for RDS). */
export async function authorizeIngressFromSg(
  ec2: AwsClient,
  groupId: string,
  fromPort: number,
  toPort: number,
  sourceSgId: string,
  description: string,
): Promise<void> {
  await ec2.query({
    Action: "AuthorizeSecurityGroupIngress",
    Version: EC2_VERSION,
    GroupId: groupId,
    "IpPermissions.1.IpProtocol": "tcp",
    "IpPermissions.1.FromPort": String(fromPort),
    "IpPermissions.1.ToPort": String(toPort),
    "IpPermissions.1.Groups.1.GroupId": sourceSgId,
    "IpPermissions.1.Groups.1.Description": description,
  });
}

/** Describe key pairs matching a filter; returns true if at least one found. */
export async function keyPairExists(
  ec2: AwsClient,
  name: string,
): Promise<boolean> {
  const xml = await ec2.query({
    Action: "DescribeKeyPairs",
    Version: EC2_VERSION,
    "Filter.1.Name": "key-name",
    "Filter.1.Value.1": name,
  });
  return !!xmlText(xml, "keyName");
}

/** Delete a key pair by name. */
export async function deleteKeyPair(
  ec2: AwsClient,
  name: string,
): Promise<void> {
  await ec2.query({
    Action: "DeleteKeyPair",
    Version: EC2_VERSION,
    KeyName: name,
  });
}

/** Delete a security group by ID. */
export async function deleteSecurityGroup(
  ec2: AwsClient,
  groupId: string,
): Promise<void> {
  await ec2.query({
    Action: "DeleteSecurityGroup",
    Version: EC2_VERSION,
    GroupId: groupId,
  });
}

/** List instance IDs for a tag filter, excluding terminated ones. */
export async function listInstanceIdsByTag(
  ec2: AwsClient,
  env: string,
): Promise<string[]> {
  const xml = await ec2.query({
    Action: "DescribeInstances",
    Version: EC2_VERSION,
    "Filter.1.Name": `tag:${SF_TAG_KEY}`,
    "Filter.1.Value.1": env,
  });
  const ids: string[] = [];
  const items = xmlBlocks(xml, "item");
  for (const item of items) {
    const instanceId = xmlText(item, "instanceId");
    const state = xmlText(item, "name");
    if (instanceId && state !== "terminated") ids.push(instanceId);
  }
  return ids;
}

/** Terminate instances. */
export async function terminateInstances(
  ec2: AwsClient,
  instanceIds: string[],
): Promise<void> {
  const params: Record<string, string> = {
    Action: "TerminateInstances",
    Version: EC2_VERSION,
  };
  instanceIds.forEach((id, i) => {
    params[`InstanceId.${i + 1}`] = id;
  });
  await ec2.query(params);
}
