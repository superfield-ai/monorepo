/**
 * Resolves the latest Ubuntu 24.04 LTS (Noble Numbat) AMI for the current
 * region via the public SSM Parameter Store path Canonical publishes:
 *
 *   /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id
 *
 * This is preferred over `DescribeImages` because Canonical guarantees the
 * value here always reflects the current daily-built image without needing
 * to filter and sort `ami-*-server-*` names by creation date.
 *
 * Uses plain fetch() + SigV4 against the SSM Query API.
 * API version: 2014-11-06.
 */

import type { AwsClient } from "./clients.js";

const SSM_VERSION = "2014-11-06";

export const UBUNTU_NOBLE_AMI_PARAM =
  "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id";

function xmlText(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "s");
  return re.exec(xml)?.[1] ?? undefined;
}

export async function resolveUbuntuNobleAmi(ssm: AwsClient): Promise<string> {
  const xml = await ssm.query({
    Action: "GetParameter",
    Version: SSM_VERSION,
    Name: UBUNTU_NOBLE_AMI_PARAM,
  });
  const value = xmlText(xml, "Value");
  if (!value) {
    throw new Error(
      `SSM parameter ${UBUNTU_NOBLE_AMI_PARAM} returned no value`,
    );
  }
  return value;
}
