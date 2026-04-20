import {
  createPrivateKey,
  createPublicKey,
  hkdfSync,
} from "node:crypto";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist as englishWordlist } from "@scure/bip39/wordlists/english";

const SALT = "superfield-secrets-v1";
const NAMESPACE_VERSION = "v1";

/**
 * Read a BIP-39 mnemonic from the SUPERFIELD_MNEMONIC environment variable
 * (default) or an interactive TTY prompt.
 *
 * Returns a Buffer holding the UTF-8 mnemonic. Callers MUST zero this Buffer
 * (`buf.fill(0)`) when finished — typically by passing it to one of the
 * derive* functions, which zero it in their own `finally` blocks.
 *
 * The mnemonic is never written to stdout, stderr, files, or process args
 * by this function.
 */
export async function readMnemonic(): Promise<Buffer> {
  const fromEnv = process.env.SUPERFIELD_MNEMONIC;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    const buf = Buffer.from(fromEnv, "utf8");
    // Best-effort: scrub the env var so it is not echoed by accidental
    // process inspection. The string already exists in the V8 heap, but
    // removing the env binding limits casual exposure.
    delete process.env.SUPERFIELD_MNEMONIC;
    assertValidMnemonic(buf);
    return buf;
  }
  const buf = await promptMnemonic();
  assertValidMnemonic(buf);
  return buf;
}

/**
 * Derive a deterministic Ed25519 keypair from `mnemonic` under the namespace
 * `v1/<env>/<purpose>`. Returns the OpenSSH-format public key and a PEM
 * (PKCS#8) private key.
 *
 * The supplied `mnemonic` Buffer is zeroed before this function returns,
 * regardless of success or failure. Callers must not reuse it afterwards.
 */
export function deriveEd25519Key(
  mnemonic: Buffer,
  env: string,
  purpose: string,
): { publicKeyOpenSsh: string; privateKeyPem: string } {
  let seed: Buffer | null = null;
  let raw: Buffer | null = null;
  try {
    const info = buildNamespace(env, purpose);
    seed = mnemonicSeed(mnemonic);
    raw = hkdfBytes(seed, info, 32);
    const privateKey = createPrivateKey({
      key: ed25519Pkcs8Der(raw),
      format: "der",
      type: "pkcs8",
    });
    const publicKey = createPublicKey(privateKey);
    const privateKeyPem = privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString();
    const publicKeyOpenSsh = formatOpenSshEd25519(
      publicKey.export({ format: "der", type: "spki" }) as Buffer,
    );
    return { publicKeyOpenSsh, privateKeyPem };
  } finally {
    if (seed) seed.fill(0);
    if (raw) raw.fill(0);
    mnemonic.fill(0);
  }
}

/**
 * Derive a deterministic password (hex-encoded random bytes) of `length`
 * bytes — i.e. the returned string is `length * 2` hex characters.
 *
 * The supplied `mnemonic` Buffer is zeroed before return.
 */
export function derivePassword(
  mnemonic: Buffer,
  env: string,
  purpose: string,
  length: number,
): string {
  let seed: Buffer | null = null;
  let raw: Buffer | null = null;
  try {
    const info = buildNamespace(env, purpose);
    seed = mnemonicSeed(mnemonic);
    raw = hkdfBytes(seed, info, length);
    return raw.toString("hex");
  } finally {
    if (seed) seed.fill(0);
    if (raw) raw.fill(0);
    mnemonic.fill(0);
  }
}

/**
 * Derive a deterministic HMAC-style token of `bytes` random bytes,
 * hex-encoded. Identical mechanics to `derivePassword` — the separate name
 * documents intent at call sites (webhook secrets, cookie secrets, etc.).
 */
export function deriveHmacToken(
  mnemonic: Buffer,
  env: string,
  purpose: string,
  bytes: number,
): string {
  let seed: Buffer | null = null;
  let raw: Buffer | null = null;
  try {
    const info = buildNamespace(env, purpose);
    seed = mnemonicSeed(mnemonic);
    raw = hkdfBytes(seed, info, bytes);
    return raw.toString("hex");
  } finally {
    if (seed) seed.fill(0);
    if (raw) raw.fill(0);
    mnemonic.fill(0);
  }
}

// ---- internal helpers (not exported) ----

function buildNamespace(env: string, purpose: string): string {
  if (
    typeof env !== "string" ||
    typeof purpose !== "string" ||
    env.length === 0 ||
    purpose.length === 0 ||
    env.includes("/") ||
    purpose.includes("/")
  ) {
    throw new Error("namespace must be versioned (v1/...)");
  }
  const info = `${NAMESPACE_VERSION}/${env}/${purpose}`;
  if (!info.startsWith("v1/")) {
    // Defensive — unreachable given the constant, but the spec requires
    // an explicit guard on the assembled namespace.
    throw new Error("namespace must be versioned (v1/...)");
  }
  return info;
}

function mnemonicSeed(mnemonic: Buffer): Buffer {
  // @scure/bip39 expects a string. We materialize a temporary string from
  // the buffer, then immediately drop the reference; the underlying buffer
  // bytes stay under our control and are zeroed by the caller's finally.
  const phrase = mnemonic.toString("utf8");
  const seedBytes = mnemonicToSeedSync(phrase);
  return Buffer.from(seedBytes);
}

function hkdfBytes(seed: Buffer, info: string, length: number): Buffer {
  const out = hkdfSync("sha256", seed, SALT, info, length);
  return Buffer.from(out);
}

function assertValidMnemonic(mnemonic: Buffer): void {
  const phrase = mnemonic.toString("utf8");
  if (!validateMnemonic(phrase, englishWordlist)) {
    mnemonic.fill(0);
    throw new Error("invalid BIP-39 mnemonic");
  }
}

async function promptMnemonic(): Promise<Buffer> {
  // Lazy-import readline so module load has no side effects.
  const readline = await import("node:readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
  // Disable echo for the duration of the prompt so the mnemonic does not
  // appear on the terminal or in scrollback.
  const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
  const wasRaw = stdin.isTTY ? stdin.isRaw : false;
  if (stdin.isTTY && typeof stdin.setRawMode === "function") {
    stdin.setRawMode(true);
  }
  process.stderr.write("mnemonic: ");
  try {
    const answer: string = await new Promise((resolve) => {
      rl.question("", (a) => resolve(a));
    });
    return Buffer.from(answer, "utf8");
  } finally {
    if (stdin.isTTY && typeof stdin.setRawMode === "function") {
      stdin.setRawMode(wasRaw ?? false);
    }
    rl.close();
    process.stderr.write("\n");
  }
}

// Encode 32 raw Ed25519 private key bytes as PKCS#8 DER. Ed25519 PKCS#8 has
// a fixed 16-byte prefix followed by the 32-byte seed.
function ed25519Pkcs8Der(rawSeed: Buffer): Buffer {
  if (rawSeed.length !== 32) {
    throw new Error("ed25519 seed must be 32 bytes");
  }
  const prefix = Buffer.from([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
    0x04, 0x22, 0x04, 0x20,
  ]);
  return Buffer.concat([prefix, rawSeed]);
}

// Format an Ed25519 SPKI DER public key as the OpenSSH single-line form:
//   "ssh-ed25519 <base64-payload>"
function formatOpenSshEd25519(spkiDer: Buffer): string {
  // SPKI for Ed25519 is a fixed 12-byte prefix + 32-byte raw key.
  const raw = spkiDer.subarray(spkiDer.length - 32);
  const algo = Buffer.from("ssh-ed25519", "utf8");
  const payload = Buffer.concat([
    sshString(algo),
    sshString(raw),
  ]);
  return `ssh-ed25519 ${payload.toString("base64")}`;
}

function sshString(buf: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}
