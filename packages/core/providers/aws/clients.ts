/**
 * Default AWS SDK v3 client factory.
 *
 * Production callers construct clients via this helper; tests pass their own
 * client objects to `provision`. We use the standard credential provider
 * chain (env -> shared config file -> IMDS) via
 * `@aws-sdk/credential-providers#fromNodeProviderChain`.
 */

import { EC2Client } from "@aws-sdk/client-ec2";
import { RDSClient } from "@aws-sdk/client-rds";
import { SSMClient } from "@aws-sdk/client-ssm";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";

export interface DefaultClients {
  ec2: EC2Client;
  rds: RDSClient;
  ssm: SSMClient;
}

export function buildDefaultClients(region: string): DefaultClients {
  const credentials = fromNodeProviderChain();
  return {
    ec2: new EC2Client({ region, credentials }),
    rds: new RDSClient({ region, credentials }),
    ssm: new SSMClient({ region, credentials }),
  };
}
