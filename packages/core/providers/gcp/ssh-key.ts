import { generateKeyPairSync } from "node:crypto";

/**
 * Generate an ephemeral Ed25519 keypair for first-bootstrap SSH access.
 *
 * Returns the OpenSSH-formatted public key (single line, suitable for
 * `authorized_keys` / GCE SSH metadata) and a PEM-encoded PKCS#8 private
 * key. The keypair is NOT derived from the operator mnemonic — it is
 * intended to be used once for bootstrap and then discarded.
 */
export function generateEphemeralSshKey(): {
  publicKeyOpenSsh: string;
  privateKeyPem: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  const spkiDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const publicKeyOpenSsh = formatOpenSshEd25519(spkiDer);
  return { publicKeyOpenSsh, privateKeyPem };
}

// Format an Ed25519 SPKI DER public key as the OpenSSH single-line form.
// SPKI for Ed25519 is a 12-byte prefix + 32-byte raw key.
function formatOpenSshEd25519(spkiDer: Buffer): string {
  const raw = spkiDer.subarray(spkiDer.length - 32);
  const algo = Buffer.from("ssh-ed25519", "utf8");
  const payload = Buffer.concat([sshString(algo), sshString(raw)]);
  return `ssh-ed25519 ${payload.toString("base64")}`;
}

function sshString(buf: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}
