/**
 * Hand-rolled AWS SDK v3 client doubles for the AWS provider tests.
 *
 * NOT a mocking library — repo policy forbids `vi.fn`, `vi.mock`,
 * `vi.spyOn`, `vi.stubGlobal`, and tools like `aws-sdk-client-mock`. The
 * doubles below are real objects whose `.send(command)` is a switch on
 * `command.constructor.name` returning fixture-shaped plain objects.
 *
 * Each double also records the sequence of commands it receives so tests
 * can assert ordering and the second-run-reuses-by-tag behavior.
 */

import {
  AuthorizeSecurityGroupIngressCommand,
  CreateSecurityGroupCommand,
  CreateTagsCommand,
  DeleteKeyPairCommand,
  DeleteSecurityGroupCommand,
  DescribeInstancesCommand,
  DescribeKeyPairsCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  ImportKeyPairCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
  type EC2Client,
} from "@aws-sdk/client-ec2";
import {
  CreateDBInstanceCommand,
  CreateDBSubnetGroupCommand,
  DeleteDBInstanceCommand,
  DeleteDBSubnetGroupCommand,
  DescribeDBInstancesCommand,
  DescribeDBSubnetGroupsCommand,
  type RDSClient,
} from "@aws-sdk/client-rds";
import { GetParameterCommand, type SSMClient } from "@aws-sdk/client-ssm";

export interface AwsState {
  amiId: string;
  vpcId: string;
  subnets: Array<{ id: string; az: string }>;
  // group-name -> sg
  securityGroups: Map<
    string,
    { id: string; vpcId: string; tags: Record<string, string> }
  >;
  // key-name -> material
  keyPairs: Set<string>;
  instances: Array<{
    id: string;
    state: string;
    publicDns: string;
    publicIp: string;
    tags: Record<string, string>;
  }>;
  dbSubnetGroups: Set<string>;
  dbInstances: Map<string, { status: string; address: string; port: number }>;
}

export function freshState(): AwsState {
  return {
    amiId: "ami-0abcdef1234567890",
    vpcId: "vpc-default",
    subnets: [
      { id: "subnet-a", az: "us-east-1a" },
      { id: "subnet-b", az: "us-east-1b" },
      { id: "subnet-a2", az: "us-east-1a" }, // duplicate AZ to exercise dedup
    ],
    securityGroups: new Map(),
    keyPairs: new Set(),
    instances: [],
    dbSubnetGroups: new Set(),
    dbInstances: new Map(),
  };
}

export interface CallLog {
  ec2: string[];
  rds: string[];
  ssm: string[];
}

export function freshLog(): CallLog {
  return { ec2: [], rds: [], ssm: [] };
}

export function makeFakeEc2(state: AwsState, log: CallLog): EC2Client {
  let sgCounter = 0;
  let instCounter = 0;
  const send = async (command: object): Promise<unknown> => {
    const name = command.constructor.name;
    log.ec2.push(name);
    const input = (command as { input: Record<string, unknown> }).input;

    if (command instanceof DescribeVpcsCommand) {
      return { Vpcs: [{ VpcId: state.vpcId }] };
    }
    if (command instanceof DescribeSubnetsCommand) {
      return {
        Subnets: state.subnets.map((s) => ({
          SubnetId: s.id,
          AvailabilityZone: s.az,
        })),
      };
    }
    if (command instanceof DescribeSecurityGroupsCommand) {
      const filters = (input.Filters ?? []) as Array<{
        Name: string;
        Values: string[];
      }>;
      const nameFilter = filters.find((f) => f.Name === "group-name");
      if (nameFilter) {
        const sg = state.securityGroups.get(nameFilter.Values[0] as string);
        return {
          SecurityGroups: sg
            ? [{ GroupId: sg.id, GroupName: nameFilter.Values[0] }]
            : [],
        };
      }
      const tagFilter = filters.find((f) => f.Name.startsWith("tag:"));
      if (tagFilter) {
        const env = tagFilter.Values[0] as string;
        const groups = [...state.securityGroups.entries()]
          .filter(([, sg]) => sg.tags["superfield-env"] === env)
          .map(([gname, sg]) => ({ GroupId: sg.id, GroupName: gname }));
        return { SecurityGroups: groups };
      }
      return { SecurityGroups: [] };
    }
    if (command instanceof CreateSecurityGroupCommand) {
      const id = `sg-${++sgCounter}`;
      const tags: Record<string, string> = {};
      for (const ts of input.TagSpecifications as Array<{
        Tags: Array<{ Key: string; Value: string }>;
      }>) {
        for (const t of ts.Tags) tags[t.Key] = t.Value;
      }
      state.securityGroups.set(input.GroupName as string, {
        id,
        vpcId: input.VpcId as string,
        tags,
      });
      return { GroupId: id };
    }
    if (command instanceof AuthorizeSecurityGroupIngressCommand) {
      return {};
    }
    if (command instanceof DescribeKeyPairsCommand) {
      const filters = input.Filters as Array<{
        Name: string;
        Values: string[];
      }>;
      const nameFilter = filters.find((f) => f.Name === "key-name");
      const kn = nameFilter?.Values[0] as string;
      return {
        KeyPairs: state.keyPairs.has(kn) ? [{ KeyName: kn }] : [],
      };
    }
    if (command instanceof ImportKeyPairCommand) {
      state.keyPairs.add(input.KeyName as string);
      return { KeyName: input.KeyName };
    }
    if (command instanceof DescribeInstancesCommand) {
      let matches = state.instances;
      if (input.InstanceIds) {
        const wanted = new Set(input.InstanceIds as string[]);
        matches = matches.filter((i) => wanted.has(i.id));
      }
      if (input.Filters) {
        for (const f of input.Filters as Array<{
          Name: string;
          Values: string[];
        }>) {
          if (f.Name.startsWith("tag:")) {
            const env = f.Values[0] as string;
            matches = matches.filter((i) => i.tags["superfield-env"] === env);
          }
          if (f.Name === "instance-state-name") {
            const allowed = new Set(f.Values);
            matches = matches.filter((i) => allowed.has(i.state));
          }
        }
      }
      return {
        Reservations: [
          {
            Instances: matches.map((i) => ({
              InstanceId: i.id,
              State: { Name: i.state },
              PublicDnsName: i.publicDns,
              PublicIpAddress: i.publicIp,
            })),
          },
        ],
      };
    }
    if (command instanceof RunInstancesCommand) {
      const id = `i-${++instCounter}`;
      const tags: Record<string, string> = {};
      const tagSpecs = input.TagSpecifications as Array<{
        ResourceType: string;
        Tags: Array<{ Key: string; Value: string }>;
      }>;
      for (const ts of tagSpecs) {
        if (ts.ResourceType !== "instance") continue;
        for (const t of ts.Tags) tags[t.Key] = t.Value;
      }
      state.instances.push({
        id,
        state: "running",
        publicDns: `ec2-${id}.compute.amazonaws.com`,
        publicIp: "203.0.113.10",
        tags,
      });
      return { Instances: [{ InstanceId: id }] };
    }
    if (command instanceof CreateTagsCommand) {
      return {};
    }
    if (command instanceof TerminateInstancesCommand) {
      const ids = new Set(input.InstanceIds as string[]);
      for (const i of state.instances) {
        if (ids.has(i.id)) i.state = "terminated";
      }
      return {};
    }
    if (command instanceof DeleteKeyPairCommand) {
      state.keyPairs.delete(input.KeyName as string);
      return {};
    }
    if (command instanceof DeleteSecurityGroupCommand) {
      const id = input.GroupId as string;
      for (const [name, sg] of state.securityGroups.entries()) {
        if (sg.id === id) {
          state.securityGroups.delete(name);
          break;
        }
      }
      return {};
    }
    throw new Error(`fake EC2: unhandled command ${name}`);
  };
  return { send } as unknown as EC2Client;
}

export function makeFakeRds(state: AwsState, log: CallLog): RDSClient {
  const send = async (command: object): Promise<unknown> => {
    const name = command.constructor.name;
    log.rds.push(name);
    const input = (command as { input: Record<string, unknown> }).input;

    if (command instanceof DescribeDBSubnetGroupsCommand) {
      const sgName = input.DBSubnetGroupName as string;
      if (state.dbSubnetGroups.has(sgName)) {
        return { DBSubnetGroups: [{ DBSubnetGroupName: sgName }] };
      }
      const err = new Error("DB subnet group not found");
      err.name = "DBSubnetGroupNotFoundFault";
      throw err;
    }
    if (command instanceof CreateDBSubnetGroupCommand) {
      state.dbSubnetGroups.add(input.DBSubnetGroupName as string);
      return {};
    }
    if (command instanceof DescribeDBInstancesCommand) {
      const id = input.DBInstanceIdentifier as string;
      const inst = state.dbInstances.get(id);
      if (!inst) {
        const err = new Error("DB instance not found");
        err.name = "DBInstanceNotFoundFault";
        throw err;
      }
      return {
        DBInstances: [
          {
            DBInstanceIdentifier: id,
            DBInstanceStatus: inst.status,
            Endpoint: { Address: inst.address, Port: inst.port },
          },
        ],
      };
    }
    if (command instanceof DeleteDBInstanceCommand) {
      state.dbInstances.delete(input.DBInstanceIdentifier as string);
      return {};
    }
    if (command instanceof DeleteDBSubnetGroupCommand) {
      state.dbSubnetGroups.delete(input.DBSubnetGroupName as string);
      return {};
    }
    if (command instanceof CreateDBInstanceCommand) {
      const id = input.DBInstanceIdentifier as string;
      state.dbInstances.set(id, {
        status: "available",
        address: `${id}.cluster-xyz.us-east-1.rds.amazonaws.com`,
        port: 5432,
      });
      return {};
    }
    throw new Error(`fake RDS: unhandled command ${name}`);
  };
  return { send } as unknown as RDSClient;
}

export function makeFakeSsm(state: AwsState, log: CallLog): SSMClient {
  const send = async (command: object): Promise<unknown> => {
    const name = command.constructor.name;
    log.ssm.push(name);
    if (command instanceof GetParameterCommand) {
      return { Parameter: { Value: state.amiId } };
    }
    throw new Error(`fake SSM: unhandled command ${name}`);
  };
  return { send } as unknown as SSMClient;
}
