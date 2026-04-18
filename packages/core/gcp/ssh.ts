import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SshTunnelDeps {
  spawn: (
    cmd: string,
    args: string[],
    opts?: { detached?: boolean },
  ) => ChildProcess;
  log: (msg: string) => void;
}

export interface SshTunnel {
  localPort: number;
  close: () => void;
}

/**
 * Opens an SSH tunnel: ssh -N -L {localPort}:{remoteHost}:{remotePort} {user}@{vmIp} [-i {keyPath}]
 * Resolves when tunnel is ready (after 1s delay — simple approach).
 * Rejects if the ssh process exits unexpectedly before resolved.
 */
export async function openSshTunnel(
  opts: {
    vmIp: string;
    user: string;
    keyPath?: string;
    remoteHost: string;
    remotePort: number;
    localPort: number;
  },
  deps: SshTunnelDeps,
): Promise<SshTunnel> {
  const { vmIp, user, keyPath, remoteHost, remotePort, localPort } = opts;

  const args = [
    "-N",
    "-L",
    `${localPort}:${remoteHost}:${remotePort}`,
    `${user}@${vmIp}`,
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
  ];

  if (keyPath) {
    args.push("-i", keyPath);
  }

  deps.log(`Opening SSH tunnel: ssh ${args.join(" ")}`);

  const proc = deps.spawn("ssh", args, { detached: false });

  return new Promise<SshTunnel>((resolve, reject) => {
    let settled = false;

    const onExit = (code: number | null) => {
      if (!settled) {
        settled = true;
        reject(
          new Error(
            `SSH tunnel process exited unexpectedly with code ${code ?? "null"}`,
          ),
        );
      }
    };

    proc.on("exit", onExit);
    proc.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    // Simple approach: wait 1s then assume tunnel is ready
    setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.removeListener("exit", onExit);
        deps.log(`SSH tunnel ready on local port ${localPort}`);
        resolve({
          localPort,
          close: () => {
            try {
              proc.kill();
            } catch {
              // ignore errors on close
            }
          },
        });
      }
    }, 1000);
  });
}

/**
 * Resolve SSH key path: checks opts.keyPath, then ~/.ssh/superfield_deploy, then ~/.ssh/id_ed25519
 */
export function resolveSshKeyPath(opts: {
  keyPath?: string;
}): string | undefined {
  if (opts.keyPath) {
    return opts.keyPath;
  }

  const candidates = [
    join(homedir(), ".ssh", "superfield_deploy"),
    join(homedir(), ".ssh", "id_ed25519"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}
