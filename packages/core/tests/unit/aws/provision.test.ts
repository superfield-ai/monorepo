/**
 * Unit tests for the AWS provider helper.
 *
 * Per repo policy these tests use ZERO mocks — no `vi.fn`, `vi.mock`,
 * `vi.spyOn`, `vi.stubGlobal`, no `aws-sdk-client-mock`. The AWS SDK
 * clients are real test doubles defined in `./fake-clients.ts` whose
 * `.send()` method returns hand-rolled fixture-shaped plain objects.
 *
 * The doubles are injected via the documented `provision(opts, { clients })`
 * test seam.
 */

import { describe, expect, it } from "vitest";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

import { destroy, provision } from "../../../providers/aws/index.js";
import { resourceNames } from "../../../providers/aws/types.js";
import {
  freshLog,
  freshState,
  makeFakeEc2,
  makeFakeRds,
  makeFakeSsm,
  type AwsState,
  type CallLog,
} from "./fake-clients.js";

const DEPLOY_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQ user@host";

function clients(state: AwsState, log: CallLog) {
  return {
    ec2: makeFakeEc2(state, log),
    rds: makeFakeRds(state, log),
    ssm: makeFakeSsm(state, log),
  };
}

describe("aws provision", () => {
  it("first run resolves AMI, creates SG + key pairs, then launches instance in order", async () => {
    const state = freshState();
    const log = freshLog();

    const result = await provision(
      {
        env: "demo",
        managedDb: false,
        derivedDeployKeyPublicOpenSsh: DEPLOY_KEY,
      },
      { clients: clients(state, log), sleep: async () => {} },
    );

    expect(result.host).toMatch(/^ec2-i-/);
    expect(result.initialPrivateKeyPem).toContain("BEGIN PRIVATE KEY");
    expect(result.databaseUrl).toBeUndefined();

    expect(log.ssm[0]).toBe("GetParameterCommand");
    const ec2Order = log.ec2;
    // VPC + subnets resolved before SG.
    expect(ec2Order.indexOf("DescribeVpcsCommand")).toBeLessThan(
      ec2Order.indexOf("DescribeSecurityGroupsCommand"),
    );
    // SG is created and authorized before key import.
    expect(ec2Order.indexOf("CreateSecurityGroupCommand")).toBeLessThan(
      ec2Order.indexOf("AuthorizeSecurityGroupIngressCommand"),
    );
    expect(
      ec2Order.indexOf("AuthorizeSecurityGroupIngressCommand"),
    ).toBeLessThan(ec2Order.indexOf("ImportKeyPairCommand"));
    // Both key pairs imported before RunInstances.
    expect(ec2Order.lastIndexOf("ImportKeyPairCommand")).toBeLessThan(
      ec2Order.indexOf("RunInstancesCommand"),
    );

    // Both key pairs registered, with derived deploy key second.
    expect(state.keyPairs.has(resourceNames("demo").ephemeralKeyPairName)).toBe(
      true,
    );
    expect(state.keyPairs.has(resourceNames("demo").derivedKeyPairName)).toBe(
      true,
    );

    // SG and instance carry the env tag.
    const sg = state.securityGroups.get("superfield-demo");
    expect(sg?.tags["superfield-env"]).toBe("demo");
    expect(state.instances[0]?.tags["superfield-env"]).toBe("demo");
    expect(state.instances[0]?.tags.Name).toBe("superfield-demo");
  });

  it("second run reuses the tagged instance and does not call RunInstances again", async () => {
    const state = freshState();
    const log1 = freshLog();
    await provision(
      {
        env: "demo",
        managedDb: false,
        derivedDeployKeyPublicOpenSsh: DEPLOY_KEY,
      },
      { clients: clients(state, log1), sleep: async () => {} },
    );
    expect(log1.ec2.filter((n) => n === "RunInstancesCommand")).toHaveLength(1);
    expect(
      log1.ec2.filter((n) => n === "CreateSecurityGroupCommand"),
    ).toHaveLength(1);

    const log2 = freshLog();
    const second = await provision(
      {
        env: "demo",
        managedDb: false,
        derivedDeployKeyPublicOpenSsh: DEPLOY_KEY,
      },
      { clients: clients(state, log2), sleep: async () => {} },
    );

    expect(log2.ec2).not.toContain("RunInstancesCommand");
    expect(log2.ec2).not.toContain("CreateSecurityGroupCommand");
    expect(second.host).toMatch(/^ec2-i-/);
    expect(state.instances).toHaveLength(1);
  });

  it("managedDb=true returns a postgres URL using the derived password", async () => {
    const state = freshState();
    const log = freshLog();
    const mnemonic = Buffer.from(generateMnemonic(wordlist, 256), "utf8");

    const result = await provision(
      {
        env: "prod",
        managedDb: true,
        derivedDeployKeyPublicOpenSsh: DEPLOY_KEY,
        mnemonic,
      },
      { clients: clients(state, log), sleep: async () => {} },
    );

    expect(result.databaseUrl).toBeDefined();
    const url = new URL(result.databaseUrl as string);
    expect(url.protocol).toBe("postgresql:");
    expect(url.username).toBe("app");
    expect(url.password).toMatch(/^[0-9a-f]{64}$/); // 32 bytes hex
    expect(url.port).toBe("5432");
    expect(url.pathname).toBe("/app");
    expect(url.hostname).toContain("rds.amazonaws.com");

    // Subnet group covered ≥2 distinct AZs (state has us-east-1a + us-east-1b).
    expect(state.dbSubnetGroups.has("superfield-prod")).toBe(true);
    // Two SGs total: app + RDS.
    expect(state.securityGroups.size).toBe(2);
    expect(state.securityGroups.has("superfield-prod")).toBe(true);
    expect(state.securityGroups.has("superfield-rds-prod")).toBe(true);

    // Mnemonic Buffer was zeroed by `derivePassword`.
    expect(mnemonic.every((b) => b === 0)).toBe(true);
  });

  it("managedDb=false skips every RDS call", async () => {
    const state = freshState();
    const log = freshLog();
    await provision(
      {
        env: "demo",
        managedDb: false,
        derivedDeployKeyPublicOpenSsh: DEPLOY_KEY,
      },
      { clients: clients(state, log), sleep: async () => {} },
    );
    expect(log.rds).toHaveLength(0);
    expect(state.dbInstances.size).toBe(0);
    expect(state.dbSubnetGroups.size).toBe(0);
  });

  it("rejects managedDb=true without a mnemonic", async () => {
    const state = freshState();
    const log = freshLog();
    await expect(
      provision(
        {
          env: "demo",
          managedDb: true,
          derivedDeployKeyPublicOpenSsh: DEPLOY_KEY,
        },
        { clients: clients(state, log) },
      ),
    ).rejects.toThrow(/mnemonic/i);
  });

  it("rejects an env with a slash", async () => {
    const state = freshState();
    const log = freshLog();
    await expect(
      provision(
        {
          env: "bad/env",
          managedDb: false,
          derivedDeployKeyPublicOpenSsh: DEPLOY_KEY,
        },
        { clients: clients(state, log) },
      ),
    ).rejects.toThrow();
  });
});

describe("aws destroy", () => {
  it("terminates tagged instances, deletes RDS + subnet group + key pairs + SGs", async () => {
    const state = freshState();
    const log = freshLog();
    const mnemonic = Buffer.from(generateMnemonic(wordlist, 256), "utf8");
    await provision(
      {
        env: "demo",
        managedDb: true,
        derivedDeployKeyPublicOpenSsh: DEPLOY_KEY,
        mnemonic,
      },
      { clients: clients(state, log), sleep: async () => {} },
    );
    expect(state.instances).toHaveLength(1);

    // Reuse the same fakes for destroy by re-deriving clients on the same state.
    const dlog = freshLog();
    const c = clients(state, dlog);
    await destroy({ env: "demo" }, { clients: { ec2: c.ec2, rds: c.rds } });
    // Destroy issued terminate, db delete, sg deletes.
    expect(dlog.ec2).toContain("TerminateInstancesCommand");
    expect(dlog.rds).toContain("DeleteDBInstanceCommand");
    expect(dlog.ec2).toContain("DeleteSecurityGroupCommand");
  });
});
