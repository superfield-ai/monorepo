/**
 * Hand-rolled AWS client doubles for the AWS provider tests.
 *
 * NOT a mocking library — repo policy forbids `vi.fn`, `vi.mock`,
 * `vi.spyOn`, `vi.stubGlobal`. The doubles below are real objects whose
 * `.query(params)` method dispatches on `params.Action` and returns fixture-
 * shaped XML strings that mirror the real AWS Query API response format.
 *
 * Each double also records the sequence of actions it receives so tests can
 * assert ordering and the second-run-reuses-by-tag behavior.
 */

import type { AwsClient } from "../../../providers/aws/clients.js";

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

// ---------------------------------------------------------------------------
// XML builders — produce minimal but structurally correct Query API responses.
// ---------------------------------------------------------------------------

function tag(name: string, value: string | undefined): string {
  if (value === undefined) return "";
  return `<${name}>${value}</${name}>`;
}

// ---------------------------------------------------------------------------
// Fake EC2
// ---------------------------------------------------------------------------

export function makeFakeEc2(state: AwsState, log: CallLog): AwsClient {
  let sgCounter = 0;
  let instCounter = 0;

  const query = async (params: Record<string, string>): Promise<string> => {
    const action = params["Action"] ?? "Unknown";
    log.ec2.push(`${action}Command`);

    switch (action) {
      case "DescribeVpcs": {
        return `<DescribeVpcsResponse>
          <vpcSet>
            <item>${tag("vpcId", state.vpcId)}</item>
          </vpcSet>
        </DescribeVpcsResponse>`;
      }

      case "DescribeSubnets": {
        const items = state.subnets
          .map(
            (s) =>
              `<item>${tag("subnetId", s.id)}${tag("availabilityZone", s.az)}</item>`,
          )
          .join("");
        return `<DescribeSubnetsResponse><subnetSet>${items}</subnetSet></DescribeSubnetsResponse>`;
      }

      case "DescribeSecurityGroups": {
        const filterName = params["Filter.1.Name"] ?? "";
        const filterValue = params["Filter.1.Value.1"] ?? "";

        if (filterName === "group-name") {
          const sg = state.securityGroups.get(filterValue);
          if (!sg)
            return `<DescribeSecurityGroupsResponse><securityGroupInfo/></DescribeSecurityGroupsResponse>`;
          return `<DescribeSecurityGroupsResponse>
            <securityGroupInfo>
              <item>${tag("groupId", sg.id)}${tag("groupName", filterValue)}</item>
            </securityGroupInfo>
          </DescribeSecurityGroupsResponse>`;
        }
        if (filterName === "vpc-id" || filterName.startsWith("tag:")) {
          // Find groups matching tag filter for the env value.
          const env = filterValue;
          const tagKey = filterName.startsWith("tag:")
            ? filterName.slice(4)
            : "superfield-env";
          const matches = [...state.securityGroups.entries()]
            .filter(([, sg]) => sg.tags[tagKey] === env)
            .map(
              ([name, sg]) =>
                `<item>${tag("groupId", sg.id)}${tag("groupName", name)}</item>`,
            )
            .join("");
          return `<DescribeSecurityGroupsResponse>
            <securityGroupInfo>${matches}</securityGroupInfo>
          </DescribeSecurityGroupsResponse>`;
        }
        // Check for vpc-id filter combined with group-name (Filter.2)
        const filter2Name = params["Filter.2.Name"] ?? "";
        const filter2Value = params["Filter.2.Value.1"] ?? "";
        if (
          (filterName === "group-name" || filter2Name === "group-name") &&
          (filterName === "vpc-id" || filter2Name === "vpc-id")
        ) {
          const gname =
            filterName === "group-name" ? filterValue : filter2Value;
          const sg = state.securityGroups.get(gname);
          if (!sg)
            return `<DescribeSecurityGroupsResponse><securityGroupInfo/></DescribeSecurityGroupsResponse>`;
          return `<DescribeSecurityGroupsResponse>
            <securityGroupInfo>
              <item>${tag("groupId", sg.id)}${tag("groupName", gname)}</item>
            </securityGroupInfo>
          </DescribeSecurityGroupsResponse>`;
        }
        return `<DescribeSecurityGroupsResponse><securityGroupInfo/></DescribeSecurityGroupsResponse>`;
      }

      case "CreateSecurityGroup": {
        const id = `sg-${++sgCounter}`;
        const groupName = params["GroupName"] ?? "unknown";
        const tags: Record<string, string> = {};
        // Parse TagSpecification.1.Tag.1.Key / .Value pairs
        let i = 1;
        while (params[`TagSpecification.1.Tag.${i}.Key`]) {
          const k = params[`TagSpecification.1.Tag.${i}.Key`] as string;
          const v = params[`TagSpecification.1.Tag.${i}.Value`] ?? "";
          tags[k] = v;
          i++;
        }
        state.securityGroups.set(groupName, {
          id,
          vpcId: params["VpcId"] ?? "",
          tags,
        });
        return `<CreateSecurityGroupResponse>${tag("groupId", id)}</CreateSecurityGroupResponse>`;
      }

      case "AuthorizeSecurityGroupIngress": {
        return `<AuthorizeSecurityGroupIngressResponse/>`;
      }

      case "DescribeKeyPairs": {
        const kn = params["Filter.1.Value.1"] ?? "";
        if (state.keyPairs.has(kn)) {
          return `<DescribeKeyPairsResponse>
            <keySet><item>${tag("keyName", kn)}</item></keySet>
          </DescribeKeyPairsResponse>`;
        }
        return `<DescribeKeyPairsResponse><keySet/></DescribeKeyPairsResponse>`;
      }

      case "ImportKeyPair": {
        const kn = params["KeyName"] ?? "";
        state.keyPairs.add(kn);
        return `<ImportKeyPairResponse>${tag("keyName", kn)}</ImportKeyPairResponse>`;
      }

      case "DescribeInstances": {
        let matches = state.instances;

        // Filter by InstanceId
        const instanceId1 = params["InstanceId.1"] ?? params["InstanceIds.1"];
        if (instanceId1) {
          matches = matches.filter((i) => i.id === instanceId1);
        }

        // Filter by tag
        const filterName = params["Filter.1.Name"] ?? "";
        const filterValue = params["Filter.1.Value.1"] ?? "";
        if (filterName.startsWith("tag:")) {
          const tagKey = filterName.slice(4);
          matches = matches.filter((i) => i.tags[tagKey] === filterValue);
        }

        // Filter by state
        const stateFilter = params["Filter.2.Name"] ?? "";
        if (stateFilter === "instance-state-name") {
          const allowed = new Set<string>();
          let vi = 1;
          while (params[`Filter.2.Value.${vi}`]) {
            allowed.add(params[`Filter.2.Value.${vi}`] as string);
            vi++;
          }
          matches = matches.filter((i) => allowed.has(i.state));
        }

        const items = matches
          .map(
            (i) =>
              `<item>
                ${tag("instanceId", i.id)}
                <instanceState>${tag("name", i.state)}</instanceState>
                ${tag("dnsName", i.publicDns)}
                ${tag("ipAddress", i.publicIp)}
              </item>`,
          )
          .join("");
        return `<DescribeInstancesResponse>
          <reservationSet>
            <item><instancesSet>${items}</instancesSet></item>
          </reservationSet>
        </DescribeInstancesResponse>`;
      }

      case "RunInstances": {
        const id = `i-${++instCounter}`;
        const tags: Record<string, string> = {};
        // Parse TagSpecification.1.Tag.N.Key/.Value for resource-type=instance
        let si = 1;
        while (params[`TagSpecification.${si}.ResourceType`]) {
          if (params[`TagSpecification.${si}.ResourceType`] === "instance") {
            let ti = 1;
            while (params[`TagSpecification.${si}.Tag.${ti}.Key`]) {
              const k = params[
                `TagSpecification.${si}.Tag.${ti}.Key`
              ] as string;
              const v = params[`TagSpecification.${si}.Tag.${ti}.Value`] ?? "";
              tags[k] = v;
              ti++;
            }
          }
          si++;
        }
        state.instances.push({
          id,
          state: "running",
          publicDns: `ec2-${id}.compute.amazonaws.com`,
          publicIp: "203.0.113.10",
          tags,
        });
        return `<RunInstancesResponse>
          <instancesSet>
            <item>${tag("instanceId", id)}<instanceState>${tag("name", "running")}</instanceState></item>
          </instancesSet>
        </RunInstancesResponse>`;
      }

      case "CreateTags": {
        return `<CreateTagsResponse/>`;
      }

      case "TerminateInstances": {
        const ids = new Set<string>();
        let i = 1;
        while (params[`InstanceId.${i}`]) {
          ids.add(params[`InstanceId.${i}`] as string);
          i++;
        }
        for (const inst of state.instances) {
          if (ids.has(inst.id)) inst.state = "terminated";
        }
        return `<TerminateInstancesResponse/>`;
      }

      case "DeleteKeyPair": {
        state.keyPairs.delete(params["KeyName"] ?? "");
        return `<DeleteKeyPairResponse/>`;
      }

      case "DeleteSecurityGroup": {
        const gid = params["GroupId"] ?? "";
        for (const [name, sg] of state.securityGroups.entries()) {
          if (sg.id === gid) {
            state.securityGroups.delete(name);
            break;
          }
        }
        return `<DeleteSecurityGroupResponse/>`;
      }

      default:
        throw new Error(`fake EC2: unhandled action ${action}`);
    }
  };

  return {
    region: "us-east-1",
    service: "ec2",
    credentials: {
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "test-secret",
    },
    query,
  } as AwsClient;
}

// ---------------------------------------------------------------------------
// Fake RDS
// ---------------------------------------------------------------------------

export function makeFakeRds(state: AwsState, log: CallLog): AwsClient {
  const query = async (params: Record<string, string>): Promise<string> => {
    const action = params["Action"] ?? "Unknown";
    log.rds.push(`${action}Command`);

    switch (action) {
      case "DescribeDBSubnetGroups": {
        const name = params["DBSubnetGroupName"] ?? "";
        if (state.dbSubnetGroups.has(name)) {
          return `<DescribeDBSubnetGroupsResponse>
            <DescribeDBSubnetGroupsResult>
              <DBSubnetGroups>
                <DBSubnetGroup><DBSubnetGroupName>${name}</DBSubnetGroupName></DBSubnetGroup>
              </DBSubnetGroups>
            </DescribeDBSubnetGroupsResult>
          </DescribeDBSubnetGroupsResponse>`;
        }
        const err = new Error(
          `AWS rds DescribeDBSubnetGroups failed (404): DBSubnetGroupNotFoundFault`,
        );
        throw err;
      }

      case "CreateDBSubnetGroup": {
        state.dbSubnetGroups.add(params["DBSubnetGroupName"] ?? "");
        return `<CreateDBSubnetGroupResponse/>`;
      }

      case "DescribeDBInstances": {
        const id = params["DBInstanceIdentifier"] ?? "";
        const inst = state.dbInstances.get(id);
        if (!inst) {
          const err = new Error(
            `AWS rds DescribeDBInstances failed (404): DBInstanceNotFoundFault`,
          );
          throw err;
        }
        return `<DescribeDBInstancesResponse>
          <DescribeDBInstancesResult>
            <DBInstances>
              <DBInstance>
                <DBInstanceIdentifier>${id}</DBInstanceIdentifier>
                <DBInstanceStatus>${inst.status}</DBInstanceStatus>
                <Endpoint>
                  <Address>${inst.address}</Address>
                  <Port>${inst.port}</Port>
                </Endpoint>
              </DBInstance>
            </DBInstances>
          </DescribeDBInstancesResult>
        </DescribeDBInstancesResponse>`;
      }

      case "CreateDBInstance": {
        const id = params["DBInstanceIdentifier"] ?? "";
        state.dbInstances.set(id, {
          status: "available",
          address: `${id}.cluster-xyz.us-east-1.rds.amazonaws.com`,
          port: 5432,
        });
        return `<CreateDBInstanceResponse/>`;
      }

      case "DeleteDBInstance": {
        state.dbInstances.delete(params["DBInstanceIdentifier"] ?? "");
        return `<DeleteDBInstanceResponse/>`;
      }

      case "DeleteDBSubnetGroup": {
        state.dbSubnetGroups.delete(params["DBSubnetGroupName"] ?? "");
        return `<DeleteDBSubnetGroupResponse/>`;
      }

      default:
        throw new Error(`fake RDS: unhandled action ${action}`);
    }
  };

  return {
    region: "us-east-1",
    service: "rds",
    credentials: {
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "test-secret",
    },
    query,
  } as AwsClient;
}

// ---------------------------------------------------------------------------
// Fake SSM
// ---------------------------------------------------------------------------

export function makeFakeSsm(state: AwsState, log: CallLog): AwsClient {
  const query = async (params: Record<string, string>): Promise<string> => {
    const action = params["Action"] ?? "Unknown";
    log.ssm.push(`${action}Command`);

    switch (action) {
      case "GetParameter": {
        return `<GetParameterResponse>
          <GetParameterResult>
            <Parameter>
              <Value>${state.amiId}</Value>
            </Parameter>
          </GetParameterResult>
        </GetParameterResponse>`;
      }

      default:
        throw new Error(`fake SSM: unhandled action ${action}`);
    }
  };

  return {
    region: "us-east-1",
    service: "ssm",
    credentials: {
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "test-secret",
    },
    query,
  } as AwsClient;
}
