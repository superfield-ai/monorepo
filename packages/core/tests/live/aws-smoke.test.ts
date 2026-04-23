/**
 * Live smoke test for the AWS provider.
 *
 * Skipped unless `AWS_SMOKE_TEST_PROFILE` is set in the environment. The
 * profile name is forwarded to the AWS SDK via `AWS_PROFILE` so the
 * default credential chain picks it up. The test provisions a real
 * `superfield-smoke-<unique>` environment, asserts the returned shape,
 * then tears it down.
 */

import { afterAll, describe, expect, it } from "vitest";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

import { destroy, provision } from "../../providers/aws/index.ts";
import { deriveEd25519Key } from "../../secrets/index.ts";

const PROFILE = process.env.AWS_SMOKE_TEST_PROFILE;
const describeMaybe = PROFILE ? describe : describe.skip;

describeMaybe("aws provider live smoke", () => {
  if (PROFILE) {
    process.env.AWS_PROFILE = PROFILE;
  }

  // Use a unique env per run so concurrent CI shards don't collide.
  const env = `smoke-${Math.random().toString(36).slice(2, 8)}`;

  afterAll(
    async () => {
      if (!PROFILE) return;
      await destroy({ env });
    },
    10 * 60 * 1000,
  );

  it(
    "provisions an EC2 instance and returns a public host + private key",
    async () => {
      const mnemonic = Buffer.from(generateMnemonic(wordlist, 256), "utf8");
      const deploy = deriveEd25519Key(
        Buffer.from(mnemonic.toString("utf8"), "utf8"),
        env,
        "ssh-deploy-key",
      );
      const result = await provision({
        env,
        managedDb: false,
        derivedDeployKeyPublicOpenSsh: deploy.publicKeyOpenSsh,
      });
      expect(result.host.length).toBeGreaterThan(0);
      expect(result.initialPrivateKeyPem).toContain("BEGIN PRIVATE KEY");
    },
    10 * 60 * 1000,
  );
});
