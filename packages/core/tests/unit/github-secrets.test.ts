import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import sodium from "libsodium-wrappers";

import { putRepoSecret, sealedBoxEncrypt } from "../../github/secrets.ts";
import type { GitHubHttpDeps } from "../../github/types.ts";
import publicKeyFixture from "../fixtures/github/repo-public-key.json" with { type: "json" };
import privateKeyFixture from "../fixtures/github/repo-public-key.private.json" with { type: "json" };

const BASE = "https://api.github.com";
const REPO = "test-org/test-repo";

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

describe("sealedBoxEncrypt", () => {
  it("round-trips: ciphertext decrypts back to the plaintext", async () => {
    const plaintext = "super-secret-deploy-key-content";
    const ciphertext = await sealedBoxEncrypt(plaintext, publicKeyFixture.key);

    const decrypted = await decryptSealedBox(
      ciphertext,
      privateKeyFixture.public_key,
      privateKeyFixture.private_key,
    );
    expect(decrypted).toBe(plaintext);
  });
});

describe("putRepoSecret", () => {
  it("fetches public key, encrypts, and PUTs encrypted_value + key_id", async () => {
    let putBody: { encrypted_value?: string; key_id?: string } | null = null;

    server.use(
      http.get(
        `${BASE}/repos/${REPO}/actions/secrets/public-key`,
        () => HttpResponse.json(publicKeyFixture),
      ),
      http.put(
        `${BASE}/repos/${REPO}/actions/secrets/DEPLOY_KEY_PROD`,
        async ({ request }) => {
          putBody = (await request.json()) as typeof putBody;
          return new HttpResponse(null, { status: 201 });
        },
      ),
    );

    const plaintext = "ssh-private-key-pem-bytes-here";
    await putRepoSecret(REPO, "DEPLOY_KEY_PROD", plaintext, makeDeps());

    expect(putBody).not.toBeNull();
    expect(putBody!.key_id).toBe(publicKeyFixture.key_id);
    expect(typeof putBody!.encrypted_value).toBe("string");

    // Prove the encryption is real, not a passthrough: the body decrypts back
    // to the original plaintext using the private key paired with the fixture
    // public key.
    const decrypted = await decryptSealedBox(
      putBody!.encrypted_value!,
      privateKeyFixture.public_key,
      privateKeyFixture.private_key,
    );
    expect(decrypted).toBe(plaintext);
  });
});
