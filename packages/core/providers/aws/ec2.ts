/**
 * EC2 resource lifecycle for the AWS provider.
 *
 * Idempotent helpers for the default VPC, dedicated security group, two key
 * pairs (ephemeral + derived), and the EC2 instance itself. Each "ensure"
 * function looks the resource up by tag (or canonical name for default-VPC
 * objects) and creates it only when missing.
 */

import {
  AuthorizeSecurityGroupIngressCommand,
  CreateSecurityGroupCommand,
  CreateTagsCommand,
  type _InstanceType,
  DescribeInstancesCommand,
  DescribeKeyPairsCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  type EC2Client,
  ImportKeyPairCommand,
  RunInstancesCommand,
} from "@aws-sdk/client-ec2";

import { SF_TAG_KEY } from "./types.js";

export const SSH_INGRESS_DESCRIPTION = "superfield-ssh";

/** Look up the account's default VPC. Throws if none exists in this region. */
export async function getDefaultVpcId(ec2: EC2Client): Promise<string> {
  const out = await ec2.send(
    new DescribeVpcsCommand({
      Filters: [{ Name: "is-default", Values: ["true"] }],
    }),
  );
  const vpcId = out.Vpcs?.[0]?.VpcId;
  if (!vpcId) {
    throw new Error(
      "no default VPC in this region; create one with `aws ec2 create-default-vpc`",
    );
  }
  return vpcId;
}

/** List subnet IDs (with their AZ) belonging to the supplied VPC. */
export async function listVpcSubnets(
  ec2: EC2Client,
  vpcId: string,
): Promise<Array<{ subnetId: string; az: string }>> {
  const out = await ec2.send(
    new DescribeSubnetsCommand({
      Filters: [{ Name: "vpc-id", Values: [vpcId] }],
    }),
  );
  return (out.Subnets ?? [])
    .filter((s) => s.SubnetId && s.AvailabilityZone)
    .map((s) => ({
      subnetId: s.SubnetId as string,
      az: s.AvailabilityZone as string,
    }));
}

/**
 * Ensure the per-env security group exists and allows TCP/22 from anywhere.
 * Returns the resolved group id. Idempotent: a second call finds the
 * group by name + vpc and returns its id without re-creating it.
 */
export async function ensureSecurityGroup(
  ec2: EC2Client,
  name: string,
  vpcId: string,
  env: string,
): Promise<string> {
  const existing = await ec2.send(
    new DescribeSecurityGroupsCommand({
      Filters: [
        { Name: "group-name", Values: [name] },
        { Name: "vpc-id", Values: [vpcId] },
      ],
    }),
  );
  if (existing.SecurityGroups && existing.SecurityGroups.length > 0) {
    const sg = existing.SecurityGroups[0];
    if (!sg?.GroupId) throw new Error("security group has no GroupId");
    return sg.GroupId;
  }
  const created = await ec2.send(
    new CreateSecurityGroupCommand({
      GroupName: name,
      Description: `superfield ${env} SSH ingress`,
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
          FromPort: 22,
          ToPort: 22,
          IpRanges: [
            { CidrIp: "0.0.0.0/0", Description: SSH_INGRESS_DESCRIPTION },
          ],
        },
      ],
    }),
  );
  return groupId;
}

/**
 * Ensure a key pair with `name` is registered. If it exists, this is a
 * no-op. If not, the supplied OpenSSH public key is imported.
 */
export async function ensureImportedKeyPair(
  ec2: EC2Client,
  name: string,
  publicKeyOpenSsh: string,
  env: string,
): Promise<void> {
  const existing = await ec2.send(
    new DescribeKeyPairsCommand({
      Filters: [{ Name: "key-name", Values: [name] }],
    }),
  );
  if (existing.KeyPairs && existing.KeyPairs.length > 0) {
    return;
  }
  await ec2.send(
    new ImportKeyPairCommand({
      KeyName: name,
      PublicKeyMaterial: Buffer.from(publicKeyOpenSsh, "utf8"),
      TagSpecifications: [
        {
          ResourceType: "key-pair",
          Tags: [{ Key: SF_TAG_KEY, Value: env }],
        },
      ],
    }),
  );
}

export interface FoundInstance {
  instanceId: string;
  publicDns: string | undefined;
  publicIp: string | undefined;
  state: string | undefined;
}

/** Look up an existing tagged instance for this env. */
export async function findInstanceByTag(
  ec2: EC2Client,
  env: string,
): Promise<FoundInstance | undefined> {
  const out = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: `tag:${SF_TAG_KEY}`, Values: [env] },
        {
          Name: "instance-state-name",
          Values: ["pending", "running", "stopping", "stopped"],
        },
      ],
    }),
  );
  for (const reservation of out.Reservations ?? []) {
    for (const inst of reservation.Instances ?? []) {
      if (!inst.InstanceId) continue;
      return {
        instanceId: inst.InstanceId,
        publicDns: inst.PublicDnsName || undefined,
        publicIp: inst.PublicIpAddress || undefined,
        state: inst.State?.Name,
      };
    }
  }
  return undefined;
}

/**
 * Launch a new EC2 instance with the supplied AMI, key pair, and SG.
 * Tags the instance with `superfield-env=<env>` so future runs find it.
 */
export async function runInstance(
  ec2: EC2Client,
  args: {
    amiId: string;
    instanceType: string;
    keyName: string;
    securityGroupId: string;
    env: string;
    nameTag: string;
  },
): Promise<string> {
  const out = await ec2.send(
    new RunInstancesCommand({
      ImageId: args.amiId,
      InstanceType: args.instanceType as _InstanceType,
      KeyName: args.keyName,
      SecurityGroupIds: [args.securityGroupId],
      MinCount: 1,
      MaxCount: 1,
      TagSpecifications: [
        {
          ResourceType: "instance",
          Tags: [
            { Key: SF_TAG_KEY, Value: args.env },
            { Key: "Name", Value: args.nameTag },
          ],
        },
        {
          ResourceType: "volume",
          Tags: [{ Key: SF_TAG_KEY, Value: args.env }],
        },
      ],
    }),
  );
  const id = out.Instances?.[0]?.InstanceId;
  if (!id) throw new Error("RunInstances returned no InstanceId");
  return id;
}

/** Re-tag an existing resource (used to upgrade an untagged item). */
export async function tagResource(
  ec2: EC2Client,
  resourceId: string,
  env: string,
): Promise<void> {
  await ec2.send(
    new CreateTagsCommand({
      Resources: [resourceId],
      Tags: [{ Key: SF_TAG_KEY, Value: env }],
    }),
  );
}

/**
 * Poll `DescribeInstances` until the instance has a public DNS name (or
 * IP) and is in `running` state, up to `timeoutMs`. Returns the resolved
 * host string suitable for SSH.
 */
export async function waitForInstanceHost(
  ec2: EC2Client,
  instanceId: string,
  opts: {
    timeoutMs: number;
    intervalMs: number;
    sleep: (ms: number) => Promise<void>;
  },
): Promise<string> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const out = await ec2.send(
      new DescribeInstancesCommand({ InstanceIds: [instanceId] }),
    );
    const inst = out.Reservations?.[0]?.Instances?.[0];
    const host = inst?.PublicDnsName || inst?.PublicIpAddress;
    if (inst?.State?.Name === "running" && host) {
      return host;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for instance ${instanceId} to expose a public host`,
      );
    }
    await opts.sleep(opts.intervalMs);
  }
}
