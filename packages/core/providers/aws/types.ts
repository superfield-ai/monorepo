/**
 * Shared types for the AWS provider helper.
 *
 * The provider's public surface intentionally mirrors the GCP helper so that
 * downstream code can treat all vendors uniformly: each `provision` returns a
 * plain object with `host`, `initialPrivateKeyPem`, and an optional
 * `databaseUrl`.
 */

import type { AwsClient } from "./clients.js";

export interface ProvisionOpts {
  /** AWS region. Defaults to "us-east-1". */
  region?: string;
  /** Environment name; appears in resource names + tags. */
  env: string;
  /** When true, also provisions an RDS Postgres instance. */
  managedDb: boolean;
  /**
   * OpenSSH-format public key derived from the user's mnemonic. Imported as
   * a second EC2 key pair so the deploy step can SSH in with a key the
   * caller can re-derive on demand.
   */
  derivedDeployKeyPublicOpenSsh: string;
  /**
   * BIP-39 mnemonic Buffer used to derive the RDS password when
   * `managedDb=true`. The Buffer is zeroed by `derivePassword` before
   * `provision` returns. Required when `managedDb=true`.
   */
  mnemonic?: Buffer;
}

export interface ProvisionResult {
  host: string;
  initialPrivateKeyPem: string;
  databaseUrl?: string;
}

/**
 * Optional dependency injection for tests. Production callers omit this and
 * the provider builds default clients from environment variable credentials.
 *
 * We do NOT ship a mock library. Test doubles are real objects whose `query`
 * method returns hand-rolled fixture responses; see
 * `tests/unit/aws/`.
 */
export interface ProvisionDeps {
  clients?: {
    ec2: AwsClient;
    rds: AwsClient;
    ssm: AwsClient;
  };
  /** Sleep helper, injected so tests run instantly. Default: real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Logging hook. Default: no-op. */
  log?: (msg: string) => void;
}

export const SF_TAG_KEY = "superfield-env";

export interface ResourceNames {
  securityGroupName: string;
  ephemeralKeyPairName: string;
  derivedKeyPairName: string;
  dbSubnetGroupName: string;
  dbInstanceIdentifier: string;
  instanceNameTag: string;
}

export function resourceNames(env: string): ResourceNames {
  return {
    securityGroupName: `superfield-${env}`,
    ephemeralKeyPairName: `superfield-ephemeral-${env}`,
    derivedKeyPairName: `superfield-deploy-${env}`,
    dbSubnetGroupName: `superfield-${env}`,
    dbInstanceIdentifier: `superfield-${env}`,
    instanceNameTag: `superfield-${env}`,
  };
}
