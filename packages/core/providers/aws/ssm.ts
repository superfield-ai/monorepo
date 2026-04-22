/**
 * Resolves the latest Ubuntu 24.04 LTS (Noble Numbat) AMI for the current
 * region via the public SSM Parameter Store path Canonical publishes:
 *
 *   /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id
 *
 * This is preferred over `DescribeImages` because Canonical guarantees the
 * value here always reflects the current daily-built image without needing
 * to filter and sort `ami-*-server-*` names by creation date.
 */

import { GetParameterCommand, type SSMClient } from "@aws-sdk/client-ssm";

export const UBUNTU_NOBLE_AMI_PARAM =
  "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id";

export async function resolveUbuntuNobleAmi(ssm: SSMClient): Promise<string> {
  const out = await ssm.send(
    new GetParameterCommand({ Name: UBUNTU_NOBLE_AMI_PARAM }),
  );
  const value = out.Parameter?.Value;
  if (!value) {
    throw new Error(
      `SSM parameter ${UBUNTU_NOBLE_AMI_PARAM} returned no value`,
    );
  }
  return value;
}
