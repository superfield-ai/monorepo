/**
 * Ephemeral Ed25519 EC2 key-pair generation.
 *
 * EC2's `ImportKeyPair` accepts the OpenSSH single-line public-key format
 * AWS already uses for `~/.ssh/authorized_keys`. We generate the key with
 * `node:crypto` so the private material never leaves this process and is
 * returned to the caller as a PEM (PKCS#8) string.
 */

import { generateKeyPairSync, type KeyObject } from "node:crypto";

export interface EphemeralEd25519Key {
  publicKeyOpenSsh: string;
  privateKeyPem: string;
}

export function generateEphemeralEd25519(): EphemeralEd25519Key {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  const publicKeyOpenSsh = formatOpenSshEd25519(publicKey);
  return { publicKeyOpenSsh, privateKeyPem };
}

// Encode an Ed25519 SPKI public key as the OpenSSH single-line form used by
// `~/.ssh/authorized_keys` and accepted by EC2's `ImportKeyPair`:
//   "ssh-ed25519 <base64-payload>"
function formatOpenSshEd25519(publicKey: KeyObject): string {
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  // Ed25519 SPKI is a fixed 12-byte prefix + 32-byte raw key.
  const raw = spki.subarray(spki.length - 32);
  const algo = Buffer.from("ssh-ed25519", "utf8");
  const payload = Buffer.concat([sshString(algo), sshString(raw)]);
  return `ssh-ed25519 ${payload.toString("base64")}`;
}

function sshString(buf: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}
