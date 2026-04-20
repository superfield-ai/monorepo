import { describe, it, expect } from "vitest";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  deriveEd25519Key,
  derivePassword,
  deriveHmacToken,
} from "../../../secrets/index.ts";
import * as secretsModule from "../../../secrets/index.ts";

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

// ---- known-answer vectors ----
//
// These are produced by running the v1 derivation (HKDF-SHA256, salt
// "superfield-secrets-v1", info "v1/<env>/<purpose>") over the BIP-39 seed
// of the canonical "abandon ... about" test mnemonic. They lock the wire
// format of the v1 namespace; changing them is a breaking change.

const VECTORS = {
  ed25519: {
    env: "prod",
    purpose: "ssh-deploy-key",
    publicKeyOpenSsh:
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPYEK/XIcf5LKf+WMtLKls0GQmoaTwKYMcoeUAFmR9wO",
    privateKeyPem:
      "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIAsCb8/h4fyLtYkjn0I496p1GXXapHmdQRrmtPRNs5tR\n-----END PRIVATE KEY-----\n",
  },
  password: {
    env: "prod",
    purpose: "db-password",
    length: 32,
    hex: "0f8630b0d4272d0d216c36048a83ed5dfc3779aab888870ecb81e76aacb4c654",
  },
  hmac: {
    env: "staging",
    purpose: "webhook",
    bytes: 32,
    hex: "f2cd3928400e41c71b52300b656450027df6ffb01157e2e73fcbaa2edae6e877",
  },
  passwordShort: {
    env: "demo",
    purpose: "cookie",
    length: 16,
    hex: "6430164c2bef69c0c750e6cebe1a608c",
  },
};

describe("module exports", () => {
  it("exports exactly the four documented public functions", () => {
    expect(Object.keys(secretsModule).sort()).toEqual([
      "deriveEd25519Key",
      "deriveHmacToken",
      "derivePassword",
      "readMnemonic",
    ]);
  });
});

describe("namespace enforcement", () => {
  it("derivePassword throws when env contains a slash", () => {
    const m = Buffer.from(TEST_MNEMONIC);
    expect(() => derivePassword(m, "../prod", "db-password", 32)).toThrow(
      "namespace must be versioned (v1/...)",
    );
  });

  it("deriveEd25519Key throws when purpose contains a slash", () => {
    const m = Buffer.from(TEST_MNEMONIC);
    expect(() =>
      deriveEd25519Key(m, "prod", "../v2/ssh-deploy-key"),
    ).toThrow("namespace must be versioned (v1/...)");
  });

  it("deriveHmacToken throws when env is empty", () => {
    const m = Buffer.from(TEST_MNEMONIC);
    expect(() => deriveHmacToken(m, "", "webhook", 32)).toThrow(
      "namespace must be versioned (v1/...)",
    );
  });

  it("derivePassword throws when purpose is empty", () => {
    const m = Buffer.from(TEST_MNEMONIC);
    expect(() => derivePassword(m, "prod", "", 32)).toThrow(
      "namespace must be versioned (v1/...)",
    );
  });
});

describe("known-answer vectors", () => {
  it("deriveEd25519Key matches the committed test vector", () => {
    const m = Buffer.from(TEST_MNEMONIC);
    const { ed25519 } = VECTORS;
    const out = deriveEd25519Key(m, ed25519.env, ed25519.purpose);
    expect(out.publicKeyOpenSsh).toBe(ed25519.publicKeyOpenSsh);
    expect(out.privateKeyPem).toBe(ed25519.privateKeyPem);
  });

  it("derivePassword returns a 64-character hex string matching the vector", () => {
    const m = Buffer.from(TEST_MNEMONIC);
    const { password } = VECTORS;
    const out = derivePassword(m, password.env, password.purpose, password.length);
    expect(out).toMatch(/^[0-9a-f]{64}$/);
    expect(out).toHaveLength(64);
    expect(out).toBe(password.hex);
  });

  it("deriveHmacToken returns a 64-character hex string matching the vector", () => {
    const m = Buffer.from(TEST_MNEMONIC);
    const { hmac } = VECTORS;
    const out = deriveHmacToken(m, hmac.env, hmac.purpose, hmac.bytes);
    expect(out).toMatch(/^[0-9a-f]{64}$/);
    expect(out).toHaveLength(64);
    expect(out).toBe(hmac.hex);
  });

  it("derivePassword honours the requested byte length", () => {
    const m = Buffer.from(TEST_MNEMONIC);
    const { passwordShort } = VECTORS;
    const out = derivePassword(
      m,
      passwordShort.env,
      passwordShort.purpose,
      passwordShort.length,
    );
    expect(out).toHaveLength(passwordShort.length * 2);
    expect(out).toBe(passwordShort.hex);
  });

  it("changing the env produces a different password", () => {
    const a = derivePassword(Buffer.from(TEST_MNEMONIC), "prod", "db", 32);
    const b = derivePassword(Buffer.from(TEST_MNEMONIC), "staging", "db", 32);
    expect(a).not.toBe(b);
  });

  it("changing the purpose produces a different password", () => {
    const a = derivePassword(Buffer.from(TEST_MNEMONIC), "prod", "db", 32);
    const b = derivePassword(Buffer.from(TEST_MNEMONIC), "prod", "cookie", 32);
    expect(a).not.toBe(b);
  });
});

describe("mnemonic buffer hygiene", () => {
  it("zeroes the mnemonic buffer after deriveEd25519Key", () => {
    const m = Buffer.from(TEST_MNEMONIC);
    expect(m[0]).not.toBe(0);
    deriveEd25519Key(m, "prod", "ssh-deploy-key");
    for (const byte of m) {
      expect(byte).toBe(0);
    }
  });

  it("zeroes the mnemonic buffer after derivePassword", () => {
    const m = Buffer.from(TEST_MNEMONIC);
    derivePassword(m, "prod", "db-password", 32);
    for (const byte of m) expect(byte).toBe(0);
  });

  it("zeroes the mnemonic buffer after deriveHmacToken", () => {
    const m = Buffer.from(TEST_MNEMONIC);
    deriveHmacToken(m, "prod", "webhook", 32);
    for (const byte of m) expect(byte).toBe(0);
  });

  it("zeroes the mnemonic buffer even when derivation throws", () => {
    const m = Buffer.from(TEST_MNEMONIC);
    expect(() => derivePassword(m, "../bad", "x", 32)).toThrow();
    // The throw happens before the seed is touched; the buffer-zero guard
    // must still run.
    for (const byte of m) expect(byte).toBe(0);
  });
});

describe("mnemonic never leaks", () => {
  it("does not appear in stdout, stderr, or any file written during derivation", () => {
    // Drive derivation inside a real child process so we can observe the
    // complete stdout/stderr/filesystem surface without monkey-patching
    // ESM bindings. A temp HOME/TMPDIR boxes in any file writes the child
    // or its libraries might perform, and we scan every resulting file.
    const sandbox = fsSync.mkdtempSync(
      path.join(os.tmpdir(), "sf-secrets-sandbox-"),
    );
    const home = path.join(sandbox, "home");
    const tmp = path.join(sandbox, "tmp");
    fsSync.mkdirSync(home);
    fsSync.mkdirSync(tmp);

    const driverPath = path.join(sandbox, "driver.mjs");
    const modulePath = path.resolve(
      __dirname,
      "../../../secrets/index.ts",
    );
    fsSync.writeFileSync(
      driverPath,
      `import { deriveEd25519Key, derivePassword, deriveHmacToken } from ${JSON.stringify(
        modulePath,
      )};
const M = process.env.SUPERFIELD_TEST_MNEMONIC;
let m = Buffer.from(M); deriveEd25519Key(m, "prod", "ssh-deploy-key");
m = Buffer.from(M); derivePassword(m, "prod", "db-password", 32);
m = Buffer.from(M); deriveHmacToken(m, "staging", "webhook", 32);
`,
    );

    const result = spawnSync(
      process.execPath,
      ["--bun", "run", driverPath],
      {
        env: {
          PATH: process.env.PATH,
          HOME: home,
          TMPDIR: tmp,
          SUPERFIELD_TEST_MNEMONIC: TEST_MNEMONIC,
        },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(TEST_MNEMONIC);
    expect(result.stderr).not.toContain(TEST_MNEMONIC);
    expect(result.stdout).not.toContain("abandon abandon");
    expect(result.stderr).not.toContain("abandon abandon");

    // Walk the sandbox: any file the child (or any code it loaded) wrote
    // must not contain the mnemonic. Exclude the driver script itself,
    // which we authored and which references the env var name only.
    const bad: string[] = [];
    function walk(dir: string): void {
      for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(p);
          continue;
        }
        if (p === driverPath) continue;
        let contents: string;
        try {
          contents = fsSync.readFileSync(p, "utf8");
        } catch {
          continue;
        }
        if (contents.includes(TEST_MNEMONIC)) bad.push(p);
      }
    }
    walk(sandbox);
    expect(bad).toEqual([]);
  });

  it("does not leave the mnemonic anywhere in process.argv", () => {
    expect(process.argv.join(" ")).not.toContain(TEST_MNEMONIC);
    const m = Buffer.from(TEST_MNEMONIC);
    derivePassword(m, "prod", "db-password", 32);
    expect(process.argv.join(" ")).not.toContain(TEST_MNEMONIC);
  });
});
