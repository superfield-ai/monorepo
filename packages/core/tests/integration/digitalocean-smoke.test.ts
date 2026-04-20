/**
 * Smoke test for the DigitalOcean provider (issue #150).
 *
 * Skipped unless `DIGITALOCEAN_TOKEN` is present and `RUN_DO_SMOKE=1` is set
 * (the second guard avoids accidentally spending money during normal CI).
 *
 * The test calls `provision()` once with a unique env name and then
 * `destroy()` to clean up — full real-network round trip.
 */

import { describe, it, expect } from "vitest";
import {
  provision,
  destroy,
} from "../../providers/digitalocean/index.ts";

const HAS_TOKEN =
  typeof process.env.DIGITALOCEAN_TOKEN === "string" &&
  process.env.DIGITALOCEAN_TOKEN.length > 0;
const SMOKE_ENABLED = process.env.RUN_DO_SMOKE === "1";

const describeIf = HAS_TOKEN && SMOKE_ENABLED ? describe : describe.skip;

describeIf("digitalocean smoke (real DO API)", () => {
  it("provisions and tears down a droplet", async () => {
    const env = `smoke-${Date.now().toString(36)}`;
    const derived =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAm5sIeRkpTrcZRn9C5Q3xZRFNjjwOe6oHMzS6jL3sUm smoke";
    try {
      const result = await provision({
        env,
        managedDb: false,
        derivedDeployKeyPublicOpenSsh: derived,
      });
      expect(result.host).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      expect(result.initialPrivateKeyPem).toMatch(/BEGIN PRIVATE KEY/);
    } finally {
      await destroy({ env });
    }
  }, 5 * 60_000);
});

if (!HAS_TOKEN || !SMOKE_ENABLED) {
  // Print a single clear line so it's obvious why the test was skipped.
  console.log(
    "[digitalocean-smoke] skipped — set DIGITALOCEAN_TOKEN and RUN_DO_SMOKE=1 to run",
  );
}
