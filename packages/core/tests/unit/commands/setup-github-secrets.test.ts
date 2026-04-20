import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { createHash } from "node:crypto";
import sodium from "libsodium-wrappers";

import { pushEnvSecrets } from "../../../commands/setup-github.ts";
import type { GitHubHttpDeps } from "../../../github/types.ts";
import { deriveHmacToken } from "../../../secrets/index.ts";
import publicKeyFixture from "../../fixtures/github/repo-public-key.json" with { type: "json" };
import privateKeyFixture from "../../fixtures/github/repo-public-key.private.json" with { type: "json" };

const BASE = "https://api.github.com";
const REPO = "test-org/test-repo";
const ENV = "prod";
const ENV_UPPER = "PROD";

// Canonical BIP-39 test mnemonic.
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeDeps(): GitHubHttpDeps {
  return {
    fetch: globalThis.fetch,
    getToken: async () => "test-token",
  };
}

function fingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

async function decryptSealedBox(
  ciphertextBase64: string,
  publicKeyBase64: string,
  privateKeyBase64: string,
): Promise<string> {
  await sodium.ready;
  const ciphertext = sodium.from_base64(
    ciphertextBase64,
    sodium.base64_variants.ORIGINAL,
  );
  const publicKey = sodium.from_base64(
    publicKeyBase64,
    sodium.base64_variants.ORIGINAL,
  );
  const privateKey = sodium.from_base64(
    privateKeyBase64,
    sodium.base64_variants.ORIGINAL,
  );
  const plaintext = sodium.crypto_box_seal_open(
    ciphertext,
    publicKey,
    privateKey,
  );
  return sodium.to_string(plaintext);
}

interface FakeRepo {
  variables: Map<string, string>;
  // Map of secret name -> last decrypted value (for assertions).
  secrets: Map<string, string>;
  putCounts: { secrets: number; variablesPost: number; variablesPatch: number };
  // Track which secret names were uploaded in the most recent invocation.
  uploadedSecretNames: string[];
}

function installFakeRepo(): FakeRepo {
  const state: FakeRepo = {
    variables: new Map(),
    secrets: new Map(),
    putCounts: { secrets: 0, variablesPost: 0, variablesPatch: 0 },
    uploadedSecretNames: [],
  };

  server.use(
    http.get(`${BASE}/repos/${REPO}/actions/secrets/public-key`, () =>
      HttpResponse.json(publicKeyFixture),
    ),
    http.put(
      `${BASE}/repos/${REPO}/actions/secrets/:name`,
      async ({ request, params }) => {
        const body = (await request.json()) as {
          encrypted_value: string;
          key_id: string;
        };
        const decrypted = await decryptSealedBox(
          body.encrypted_value,
          privateKeyFixture.public_key,
          privateKeyFixture.private_key,
        );
        const name = String(params.name);
        state.secrets.set(name, decrypted);
        state.uploadedSecretNames.push(name);
        state.putCounts.secrets++;
        return new HttpResponse(null, { status: 201 });
      },
    ),
    http.get(`${BASE}/repos/${REPO}/actions/variables/:name`, ({ params }) => {
      const name = String(params.name);
      const value = state.variables.get(name);
      if (value === undefined) {
        return HttpResponse.json({ message: "Not Found" }, { status: 404 });
      }
      return HttpResponse.json({
        name,
        value,
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z",
      });
    }),
    http.post(
      `${BASE}/repos/${REPO}/actions/variables`,
      async ({ request }) => {
        const body = (await request.json()) as { name: string; value: string };
        state.variables.set(body.name, body.value);
        state.putCounts.variablesPost++;
        return new HttpResponse(null, { status: 201 });
      },
    ),
    http.patch(
      `${BASE}/repos/${REPO}/actions/variables/:name`,
      async ({ request, params }) => {
        const body = (await request.json()) as { name: string; value: string };
        state.variables.set(String(params.name), body.value);
        state.putCounts.variablesPatch++;
        return new HttpResponse(null, { status: 204 });
      },
    ),
  );

  return state;
}

function expectedNames(): string[] {
  return [
    `DEPLOY_HOST_${ENV_UPPER}`,
    `DATABASE_URL_${ENV_UPPER}`,
    `WEBHOOK_SECRET_${ENV_UPPER}`,
    `COOKIE_SECRET_${ENV_UPPER}`,
  ];
}

describe("pushEnvSecrets", () => {
  beforeEach(async () => {
    await sodium.ready;
  });

  it("uploads all four secrets and writes fingerprints on first invocation", async () => {
    const repo = installFakeRepo();

    const result = await pushEnvSecrets({
      repo: REPO,
      env: ENV,
      host: "203.0.113.10",
      databaseUrl: "postgres://app:pw@db.local:5432/app",
      mnemonic: Buffer.from(TEST_MNEMONIC, "utf8"),
      deps: makeDeps(),
    });

    expect(new Set(result.uploaded)).toEqual(new Set(expectedNames()));
    expect(result.skipped).toEqual([]);

    expect(repo.putCounts.secrets).toBe(4);
    // All four fingerprint variables were created.
    expect(repo.putCounts.variablesPost).toBe(4);
    expect(repo.putCounts.variablesPatch).toBe(0);

    // The fake decrypted each sealed box; verify the plaintexts the server
    // actually received line up with the inputs / derived values.
    expect(repo.secrets.get(`DEPLOY_HOST_${ENV_UPPER}`)).toBe("203.0.113.10");
    expect(repo.secrets.get(`DATABASE_URL_${ENV_UPPER}`)).toBe(
      "postgres://app:pw@db.local:5432/app",
    );
    const expectedWebhook = deriveHmacToken(
      Buffer.from(TEST_MNEMONIC, "utf8"),
      ENV,
      "webhook-secret",
      32,
    );
    const expectedCookie = deriveHmacToken(
      Buffer.from(TEST_MNEMONIC, "utf8"),
      ENV,
      "cookie-secret",
      32,
    );
    expect(repo.secrets.get(`WEBHOOK_SECRET_${ENV_UPPER}`)).toBe(
      expectedWebhook,
    );
    expect(repo.secrets.get(`COOKIE_SECRET_${ENV_UPPER}`)).toBe(expectedCookie);

    // Fingerprint variables match SHA-256 of the secret value.
    expect(repo.variables.get(`DEPLOY_HOST_${ENV_UPPER}_FP`)).toBe(
      fingerprint("203.0.113.10"),
    );
    expect(repo.variables.get(`DATABASE_URL_${ENV_UPPER}_FP`)).toBe(
      fingerprint("postgres://app:pw@db.local:5432/app"),
    );
    expect(repo.variables.get(`WEBHOOK_SECRET_${ENV_UPPER}_FP`)).toBe(
      fingerprint(expectedWebhook),
    );
    expect(repo.variables.get(`COOKIE_SECRET_${ENV_UPPER}_FP`)).toBe(
      fingerprint(expectedCookie),
    );
  });

  it("skips all uploads on a second invocation with the same inputs", async () => {
    const repo = installFakeRepo();

    await pushEnvSecrets({
      repo: REPO,
      env: ENV,
      host: "203.0.113.10",
      databaseUrl: "postgres://app:pw@db.local:5432/app",
      mnemonic: Buffer.from(TEST_MNEMONIC, "utf8"),
      deps: makeDeps(),
    });

    repo.putCounts.secrets = 0;
    repo.putCounts.variablesPost = 0;
    repo.putCounts.variablesPatch = 0;
    repo.uploadedSecretNames = [];

    const second = await pushEnvSecrets({
      repo: REPO,
      env: ENV,
      host: "203.0.113.10",
      databaseUrl: "postgres://app:pw@db.local:5432/app",
      mnemonic: Buffer.from(TEST_MNEMONIC, "utf8"),
      deps: makeDeps(),
    });

    expect(second.uploaded).toEqual([]);
    expect(new Set(second.skipped)).toEqual(new Set(expectedNames()));
    expect(repo.putCounts.secrets).toBe(0);
    expect(repo.putCounts.variablesPost).toBe(0);
    expect(repo.putCounts.variablesPatch).toBe(0);
  });

  it("uploads only the changed secret when only host differs", async () => {
    const repo = installFakeRepo();

    await pushEnvSecrets({
      repo: REPO,
      env: ENV,
      host: "203.0.113.10",
      databaseUrl: "postgres://app:pw@db.local:5432/app",
      mnemonic: Buffer.from(TEST_MNEMONIC, "utf8"),
      deps: makeDeps(),
    });

    repo.putCounts.secrets = 0;
    repo.putCounts.variablesPost = 0;
    repo.putCounts.variablesPatch = 0;
    repo.uploadedSecretNames = [];

    const second = await pushEnvSecrets({
      repo: REPO,
      env: ENV,
      host: "198.51.100.42",
      databaseUrl: "postgres://app:pw@db.local:5432/app",
      mnemonic: Buffer.from(TEST_MNEMONIC, "utf8"),
      deps: makeDeps(),
    });

    expect(second.uploaded).toEqual([`DEPLOY_HOST_${ENV_UPPER}`]);
    expect(new Set(second.skipped)).toEqual(
      new Set([
        `DATABASE_URL_${ENV_UPPER}`,
        `WEBHOOK_SECRET_${ENV_UPPER}`,
        `COOKIE_SECRET_${ENV_UPPER}`,
      ]),
    );
    expect(repo.putCounts.secrets).toBe(1);
    expect(repo.uploadedSecretNames).toEqual([`DEPLOY_HOST_${ENV_UPPER}`]);
    expect(repo.secrets.get(`DEPLOY_HOST_${ENV_UPPER}`)).toBe("198.51.100.42");
    expect(repo.variables.get(`DEPLOY_HOST_${ENV_UPPER}_FP`)).toBe(
      fingerprint("198.51.100.42"),
    );
  });

  it("never writes plain-text secret values to stdout or stderr", async () => {
    installFakeRepo();

    const host = "203.0.113.10";
    const databaseUrl = "postgres://app:pw@db.local:5432/app";
    const expectedWebhook = deriveHmacToken(
      Buffer.from(TEST_MNEMONIC, "utf8"),
      ENV,
      "webhook-secret",
      32,
    );
    const expectedCookie = deriveHmacToken(
      Buffer.from(TEST_MNEMONIC, "utf8"),
      ENV,
      "cookie-secret",
      32,
    );

    const captured: string[] = [];
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    const intercept = ((chunk: unknown) => {
      if (typeof chunk === "string") {
        captured.push(chunk);
      } else if (chunk instanceof Uint8Array) {
        captured.push(Buffer.from(chunk).toString("utf8"));
      }
      return true;
    }) as typeof process.stdout.write;

    process.stdout.write = intercept;
    process.stderr.write = intercept;

    try {
      await pushEnvSecrets({
        repo: REPO,
        env: ENV,
        host,
        databaseUrl,
        mnemonic: Buffer.from(TEST_MNEMONIC, "utf8"),
        deps: makeDeps(),
      });
    } finally {
      process.stdout.write = origStdoutWrite;
      process.stderr.write = origStderrWrite;
    }

    const haystack = captured.join("");
    // None of the four plaintext secret values may appear anywhere in the
    // captured output.
    expect(haystack.includes(host)).toBe(false);
    expect(haystack.includes(databaseUrl)).toBe(false);
    expect(haystack.includes(expectedWebhook)).toBe(false);
    expect(haystack.includes(expectedCookie)).toBe(false);
  });

  it("zeroes the supplied mnemonic buffer", async () => {
    installFakeRepo();
    const mnemonic = Buffer.from(TEST_MNEMONIC, "utf8");
    await pushEnvSecrets({
      repo: REPO,
      env: ENV,
      host: "203.0.113.10",
      databaseUrl: "postgres://app:pw@db.local:5432/app",
      mnemonic,
      deps: makeDeps(),
    });
    // After the call, every byte of the buffer should be zero.
    for (const byte of mnemonic) {
      expect(byte).toBe(0);
    }
  });
});
