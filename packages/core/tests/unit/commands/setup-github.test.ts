import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import sodium from "libsodium-wrappers";

import {
  registerEnvDeployKey,
  sshSha256Fingerprint,
} from "../../../commands/setup-github.ts";
import type { GitHubHttpDeps } from "../../../github/types.ts";
import { deriveEd25519Key } from "../../../secrets/index.ts";
import publicKeyFixture from "../../fixtures/github/repo-public-key.json" with { type: "json" };
import privateKeyFixture from "../../fixtures/github/repo-public-key.private.json" with { type: "json" };

const BASE = "https://api.github.com";
const REPO = "test-org/test-repo";
const ENV = "demo";

// Canonical BIP-39 vectors. These mnemonics are public test fixtures from the
// BIP-39 spec; they hold no value.
const MNEMONIC_A =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const MNEMONIC_B =
  "legal winner thank year wave sausage worth useful legal winner thank yellow";

// Derived (and committed) values from MNEMONIC_A under namespace
// `v1/demo/ssh-deploy-key`. Recomputing these locally is the spec's
// known-answer test for the v1 SSH key derivation.
const EXPECTED_PUB_A =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICjrtRKpmxERUuwzPlYm56dQLH8MOuGirmPqRXQWGCmI";
const EXPECTED_FP_A = "SHA256:jTUNyMNGyeQbhUVD6U+yDdFKB5kn1ROimWNrPzHMUdk";

const EXPECTED_PUB_B =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAXEBlNNYo3Q/+Bsbl0qislaon0+4EYH508e6E6xOMEl";
const EXPECTED_FP_B = "SHA256:HnHrknXpYTgqARIog1FRKTRAa8HewuSJM4GHLtx2GVY";

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

interface RecordedSecret {
  encrypted_value: string;
  key_id: string;
}

interface FakeRepoState {
  /** Registered deploy keys, keyed by id. */
  deployKeys: Map<number, { id: number; key: string; title: string; read_only: boolean }>;
  /** Recorded body of the most recent `PUT actions/secrets/<name>`. */
  secrets: Map<string, RecordedSecret>;
  /** Counts of how many times each secret was PUT. */
  secretPuts: Map<string, number>;
  /** Recorded value of each repo Actions variable. */
  variables: Map<string, string>;
  /** Counts of how many deploy-key POSTs we've handled. */
  deployKeyPostCount: number;
  /** Auto-incrementing id source for new deploy keys. */
  nextKeyId: number;
}

/**
 * Stand up a minimal in-memory GitHub for the slice of endpoints this command
 * uses. Tests get to assert against the resulting state instead of mocking
 * individual calls.
 */
function installFakeGithub(state: FakeRepoState): void {
  server.use(
    http.get(`${BASE}/repos/${REPO}/keys`, () =>
      HttpResponse.json(Array.from(state.deployKeys.values())),
    ),
    http.post(`${BASE}/repos/${REPO}/keys`, async ({ request }) => {
      state.deployKeyPostCount += 1;
      const body = (await request.json()) as {
        title: string;
        key: string;
        read_only: boolean;
      };
      const id = state.nextKeyId++;
      const record = {
        id,
        key: body.key,
        title: body.title,
        read_only: body.read_only,
      };
      state.deployKeys.set(id, record);
      return HttpResponse.json(
        {
          ...record,
          url: `${BASE}/repos/${REPO}/keys/${id}`,
          verified: true,
          created_at: "2026-04-18T12:00:00Z",
        },
        { status: 201 },
      );
    }),
    http.get(`${BASE}/repos/${REPO}/actions/secrets/public-key`, () =>
      HttpResponse.json(publicKeyFixture),
    ),
    http.put(
      `${BASE}/repos/${REPO}/actions/secrets/:name`,
      async ({ request, params }) => {
        const name = params.name as string;
        const body = (await request.json()) as RecordedSecret;
        state.secrets.set(name, body);
        state.secretPuts.set(
          name,
          (state.secretPuts.get(name) ?? 0) + 1,
        );
        return new HttpResponse(null, { status: 201 });
      },
    ),
    http.get(
      `${BASE}/repos/${REPO}/actions/variables/:name`,
      ({ params }) => {
        const name = params.name as string;
        const value = state.variables.get(name);
        if (value === undefined) {
          return HttpResponse.json({ message: "Not Found" }, { status: 404 });
        }
        return HttpResponse.json({
          name,
          value,
          created_at: "2026-04-18T12:00:00Z",
          updated_at: "2026-04-18T12:00:00Z",
        });
      },
    ),
    http.post(
      `${BASE}/repos/${REPO}/actions/variables`,
      async ({ request }) => {
        const body = (await request.json()) as { name: string; value: string };
        state.variables.set(body.name, body.value);
        return new HttpResponse(null, { status: 201 });
      },
    ),
    http.patch(
      `${BASE}/repos/${REPO}/actions/variables/:name`,
      async ({ request, params }) => {
        const name = params.name as string;
        const body = (await request.json()) as { name: string; value: string };
        state.variables.set(name, body.value);
        return new HttpResponse(null, { status: 204 });
      },
    ),
  );
}

function newState(): FakeRepoState {
  return {
    deployKeys: new Map(),
    secrets: new Map(),
    secretPuts: new Map(),
    variables: new Map(),
    deployKeyPostCount: 0,
    nextKeyId: 1000,
  };
}

async function decryptSealedBox(
  recorded: RecordedSecret,
): Promise<string> {
  await sodium.ready;
  const ciphertext = sodium.from_base64(
    recorded.encrypted_value,
    sodium.base64_variants.ORIGINAL,
  );
  const publicKey = sodium.from_base64(
    privateKeyFixture.public_key,
    sodium.base64_variants.ORIGINAL,
  );
  const privateKey = sodium.from_base64(
    privateKeyFixture.private_key,
    sodium.base64_variants.ORIGINAL,
  );
  return sodium.to_string(
    sodium.crypto_box_seal_open(ciphertext, publicKey, privateKey),
  );
}

describe("derived deploy key vectors", () => {
  it("MNEMONIC_A under v1/demo/ssh-deploy-key matches the committed public key + fingerprint", () => {
    const m = Buffer.from(MNEMONIC_A);
    const { publicKeyOpenSsh } = deriveEd25519Key(m, ENV, "ssh-deploy-key");
    expect(publicKeyOpenSsh).toBe(EXPECTED_PUB_A);
    expect(sshSha256Fingerprint(publicKeyOpenSsh)).toBe(EXPECTED_FP_A);
  });

  it("MNEMONIC_B under v1/demo/ssh-deploy-key matches the committed public key + fingerprint", () => {
    const m = Buffer.from(MNEMONIC_B);
    const { publicKeyOpenSsh } = deriveEd25519Key(m, ENV, "ssh-deploy-key");
    expect(publicKeyOpenSsh).toBe(EXPECTED_PUB_B);
    expect(sshSha256Fingerprint(publicKeyOpenSsh)).toBe(EXPECTED_FP_B);
  });
});

describe("registerEnvDeployKey — first invocation", () => {
  it("registers a deploy key, uploads the secret, and writes the fingerprint variable", async () => {
    const state = newState();
    installFakeGithub(state);

    const result = await registerEnvDeployKey({
      repo: REPO,
      env: ENV,
      mnemonic: Buffer.from(MNEMONIC_A),
      deps: makeDeps(),
    });

    expect(result.secretWritten).toBe(true);
    expect(result.keyId).toBe(1000);

    expect(state.deployKeyPostCount).toBe(1);
    const onlyKey = Array.from(state.deployKeys.values())[0]!;
    expect(onlyKey.title).toBe(`superfield-deploy-${ENV}`);
    expect(onlyKey.read_only).toBe(true);
    expect(onlyKey.key).toBe(EXPECTED_PUB_A);

    const recordedSecret = state.secrets.get(`DEPLOY_KEY_${ENV.toUpperCase()}`);
    expect(recordedSecret).toBeDefined();
    const decrypted = await decryptSealedBox(recordedSecret!);
    expect(decrypted).toContain("BEGIN PRIVATE KEY");

    expect(state.variables.get(`DEPLOY_KEY_${ENV.toUpperCase()}_FP`)).toBe(
      EXPECTED_FP_A,
    );
  });
});

describe("registerEnvDeployKey — second invocation, same mnemonic", () => {
  it("returns the existing keyId and skips the secret upload", async () => {
    const state = newState();
    installFakeGithub(state);

    // First run primes the world.
    const first = await registerEnvDeployKey({
      repo: REPO,
      env: ENV,
      mnemonic: Buffer.from(MNEMONIC_A),
      deps: makeDeps(),
    });
    expect(first.secretWritten).toBe(true);

    // Second run with the same mnemonic + env must be a no-op for both the
    // deploy-key registration and the secret upload.
    const second = await registerEnvDeployKey({
      repo: REPO,
      env: ENV,
      mnemonic: Buffer.from(MNEMONIC_A),
      deps: makeDeps(),
    });

    expect(second.keyId).toBe(first.keyId);
    expect(second.secretWritten).toBe(false);
    expect(state.deployKeyPostCount).toBe(1);
    expect(state.secretPuts.get(`DEPLOY_KEY_${ENV.toUpperCase()}`)).toBe(1);
  });
});

describe("registerEnvDeployKey — different mnemonic", () => {
  it("rotates the deploy key and re-uploads the secret + fingerprint", async () => {
    const state = newState();
    installFakeGithub(state);

    const first = await registerEnvDeployKey({
      repo: REPO,
      env: ENV,
      mnemonic: Buffer.from(MNEMONIC_A),
      deps: makeDeps(),
    });

    const second = await registerEnvDeployKey({
      repo: REPO,
      env: ENV,
      mnemonic: Buffer.from(MNEMONIC_B),
      deps: makeDeps(),
    });

    expect(second.secretWritten).toBe(true);
    expect(second.keyId).not.toBe(first.keyId);
    expect(state.deployKeyPostCount).toBe(2);
    expect(state.secretPuts.get(`DEPLOY_KEY_${ENV.toUpperCase()}`)).toBe(2);
    expect(state.variables.get(`DEPLOY_KEY_${ENV.toUpperCase()}_FP`)).toBe(
      EXPECTED_FP_B,
    );

    // Both keys remain on the repo (we never delete; rotation just adds the
    // new one). The fingerprint variable points at the new one.
    expect(state.deployKeys.size).toBe(2);
  });
});

describe("registerEnvDeployKey — mnemonic hygiene", () => {
  it("zeroes the supplied mnemonic buffer", async () => {
    const state = newState();
    installFakeGithub(state);

    const m = Buffer.from(MNEMONIC_A);
    expect(m[0]).not.toBe(0);
    await registerEnvDeployKey({
      repo: REPO,
      env: ENV,
      mnemonic: m,
      deps: makeDeps(),
    });
    for (const byte of m) expect(byte).toBe(0);
  });
});
