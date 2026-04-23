import { describe, expect, it } from "vitest";
import { provision, destroy } from "../../providers/gcp/index.ts";
import { getGoogleAccessToken, makeDefaultAuthDeps } from "../../gcp/auth.ts";

/**
 * Layer 3 — live smoke test against a real GCP project.
 *
 * Skipped unless `GCP_SMOKE_TEST_PROJECT` is set. Requires application
 * default credentials (or `GOOGLE_APPLICATION_CREDENTIALS`) with rights
 * to create/destroy VPC, firewall, and Compute resources in the target
 * project.
 *
 * Cost note: this provisions a real e2-small VM. Always destroys at the
 * end, even on failure.
 */

const projectId = process.env.GCP_SMOKE_TEST_PROJECT;
const region = process.env.GCP_SMOKE_TEST_REGION ?? "us-central1";
const zone = process.env.GCP_SMOKE_TEST_ZONE ?? "us-central1-a";
const env = `smoke-${Date.now().toString(36)}`;

const describeFn = projectId ? describe : describe.skip;

describeFn("providers/gcp.provision live smoke", () => {
  if (!projectId) {
    it.skip("set GCP_SMOKE_TEST_PROJECT to run this test", () => {
      expect(true).toBe(true);
    });
    return;
  }

  it(
    "provisions a VM and returns an external IP",
    async () => {
      const auth = makeDefaultAuthDeps();
      const deps = {
        fetch: globalThis.fetch,
        getAccessToken: () => getGoogleAccessToken(auth),
        log: (m: string) => {
          console.log(`[smoke] ${m}`);
        },
      };

      try {
        const result = await provision(
          {
            projectId: projectId as string,
            region,
            zone,
            env,
            managedDb: false,
            derivedDeployKeyPublicOpenSsh:
              "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPYEK/XIcf5LKf+WMtLKls0GQmoaTwKYMcoeUAFmR9wO",
          },
          deps,
        );
        expect(result.host).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
        expect(result.initialPrivateKeyPem).toContain("BEGIN PRIVATE KEY");
      } finally {
        const auth2 = makeDefaultAuthDeps();
        const cleanupDeps = {
          fetch: globalThis.fetch,
          getAccessToken: () => getGoogleAccessToken(auth2),
          log: (m: string) => {
            console.log(`[smoke cleanup] ${m}`);
          },
        };
        await destroy(
          { projectId: projectId as string, region, zone, env },
          cleanupDeps,
        ).catch((e) => {
          console.warn(`[smoke cleanup] destroy failed: ${String(e)}`);
        });
      }
    },
    10 * 60 * 1000,
  );
});
