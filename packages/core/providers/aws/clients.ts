/**
 * AWS client factory — replaces the AWS SDK with plain `fetch()` + internal
 * SigV4 signing. Credentials come exclusively from environment variables:
 *
 *   AWS_ACCESS_KEY_ID
 *   AWS_SECRET_ACCESS_KEY
 *   AWS_SESSION_TOKEN  (optional, for temporary credentials)
 */

import { signRequest } from "../../lib/sigv4.js";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/**
 * A lightweight AWS client that targets one service / region pair.
 * All methods use the AWS Query API (POST with application/x-www-form-urlencoded).
 */
export interface AwsClient {
  region: string;
  service: string;
  credentials: AwsCredentials;
  /** Send a Query API action and return the parsed XML body as a string. */
  query(params: Record<string, string>): Promise<string>;
}

export interface DefaultClients {
  ec2: AwsClient;
  rds: AwsClient;
  ssm: AwsClient;
}

function readCredentials(): AwsCredentials {
  const accessKeyId = process.env["AWS_ACCESS_KEY_ID"];
  const secretAccessKey = process.env["AWS_SECRET_ACCESS_KEY"];
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "AWS credentials missing: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY",
    );
  }
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: process.env["AWS_SESSION_TOKEN"],
  };
}

function makeClient(
  service: string,
  region: string,
  credentials: AwsCredentials,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): AwsClient {
  return {
    region,
    service,
    credentials,
    async query(params: Record<string, string>): Promise<string> {
      const url = `https://${service}.${region}.amazonaws.com/`;
      const body = new URLSearchParams(params).toString();
      const sigHeaders = signRequest({
        method: "POST",
        url,
        body,
        region,
        service,
        credentials,
      });
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          ...sigHeaders,
        },
        body,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(
          `AWS ${service} ${params["Action"] ?? "request"} failed (${response.status}): ${text}`,
        );
      }
      return text;
    },
  };
}

export function buildDefaultClients(region: string): DefaultClients {
  const credentials = readCredentials();
  return {
    ec2: makeClient("ec2", region, credentials),
    rds: makeClient("rds", region, credentials),
    ssm: makeClient("ssm", region, credentials),
  };
}
