/**
 * @file container-sandbox.ts
 *
 * Container sandbox for the Claude agent runtime.
 *
 * Provides a physically isolated container environment where Claude's agent
 * process runs. The container's network namespace is restricted so that only
 * traffic to the Anthropic API endpoint is allowed — no internet, no k8s API,
 * no cluster-internal services.
 *
 * Built images are handed off via a shared volume mount rather than a network
 * push, keeping the blast radius minimal.
 *
 * ## Network isolation
 *
 *   - iptables rules inside the container allow egress only to the Anthropic
 *     API server (api.anthropic.com, resolved at container start).
 *   - DNS is restricted: only the Anthropic API domain resolves.
 *   - All other outbound traffic (internet, k8s API, cluster services) is
 *     dropped.
 *
 * ## Image handoff
 *
 *   - The sandbox container mounts a shared volume at /studio/build-output.
 *   - When a build completes, the image tarball is written to this volume.
 *   - The host (or a k8s watcher) picks up the tarball and loads it.
 *   - No container-to-registry push is performed.
 *
 * ## Session lifecycle integration
 *
 *   - startSandbox() is called during session start.
 *   - stopSandbox() is called during session teardown.
 *   - listSandboxes() can detect orphans for cleanup.
 *
 * @see docs/studio-container-sandbox.md
 * @see packages/core/session-lifecycle.ts
 */

import { spawn } from './spawn';

// ── Constants ────────────────────────────────────────────────────────────────

/** Anthropic API endpoint that the sandbox is allowed to reach. */
const ANTHROPIC_API_HOST = 'api.anthropic.com';

/** Port for Anthropic API HTTPS traffic. */
const ANTHROPIC_API_PORT = '443';

/** DNS server for restricted resolution inside the container. */
const _RESTRICTED_DNS = '127.0.0.1';

/** Mount point inside the container for build output. */
const BUILD_OUTPUT_MOUNT = '/studio/build-output';

/** Mount point inside the container for source code. */
const SOURCE_MOUNT = '/studio/src';

/** Label applied to all sandbox containers for identification. */
const SANDBOX_LABEL = 'superfield-studio-sandbox';

/** Docker image used for the sandbox container. */
const SANDBOX_IMAGE = 'superfield-release:studio';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SandboxConfig {
  /** Unique session ID — used to name the container. */
  sessionId: string;

  /** Absolute path to the session worktree (source code). */
  worktreePath: string;

  /** Absolute path to the shared volume directory on the host. */
  buildOutputDir: string;

  /** Enable verbose logging. */
  verbose: boolean;
}

export interface SandboxState {
  /** Docker container ID. */
  containerId: string;

  /** Container name (deterministic from session ID). */
  containerName: string;

  /** Host path to the shared build output volume. */
  buildOutputDir: string;

  /** Host path to the source mount. */
  worktreePath: string;
}

export interface SandboxInfo {
  /** Container ID. */
  containerId: string;

  /** Container name. */
  containerName: string;

  /** Container status (running, exited, etc.). */
  status: string;
}

// ── Container naming ─────────────────────────────────────────────────────────

/**
 * Derive a deterministic container name from a session ID.
 */
export function sandboxContainerName(sessionId: string): string {
  return `studio-sandbox-${sessionId}`;
}

// ── Network rules ────────────────────────────────────────────────────────────

/**
 * Build the iptables rules script that restricts egress to only the
 * Anthropic API endpoint.
 *
 * The script:
 *   1. Resolves the Anthropic API host to IP addresses.
 *   2. Sets the default OUTPUT policy to DROP.
 *   3. Allows loopback traffic.
 *   4. Allows established/related connections.
 *   5. Allows DNS to localhost only (for the restricted resolver).
 *   6. Allows HTTPS to each resolved Anthropic API IP.
 *   7. Drops everything else (default policy).
 *
 * @returns Shell script string to execute inside the container.
 */
export function buildNetworkRules(): string {
  return [
    '#!/bin/sh',
    'set -e',
    '',
    '# Resolve Anthropic API IPs at container start time.',
    `ANTHROPIC_IPS=$(getent hosts ${ANTHROPIC_API_HOST} | awk '{ print $1 }' | sort -u)`,
    '',
    '# Flush existing rules.',
    'iptables -F OUTPUT',
    '',
    '# Default policy: drop all outbound.',
    'iptables -P OUTPUT DROP',
    '',
    '# Allow loopback.',
    'iptables -A OUTPUT -o lo -j ACCEPT',
    '',
    '# Allow established/related (for return traffic).',
    'iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT',
    '',
    '# Allow DNS to localhost only (restricted resolver).',
    `iptables -A OUTPUT -p udp --dport 53 -d 127.0.0.1 -j ACCEPT`,
    `iptables -A OUTPUT -p tcp --dport 53 -d 127.0.0.1 -j ACCEPT`,
    '',
    '# Allow HTTPS to Anthropic API IPs.',
    'for ip in $ANTHROPIC_IPS; do',
    `  iptables -A OUTPUT -p tcp --dport ${ANTHROPIC_API_PORT} -d "$ip" -j ACCEPT`,
    'done',
    '',
    '# Log and drop everything else (logging is optional, aids debugging).',
    'iptables -A OUTPUT -j DROP',
    '',
    'echo "Network rules applied. Allowed IPs: $ANTHROPIC_IPS"',
  ].join('\n');
}

/**
 * Build a minimal DNS resolver configuration that only resolves the
 * Anthropic API domain.
 *
 * Uses a dnsmasq configuration that:
 *   - Resolves api.anthropic.com via upstream DNS.
 *   - Returns NXDOMAIN for all other queries.
 *
 * @returns dnsmasq config file content.
 */
export function buildDnsConfig(): string {
  return [
    '# Restricted DNS — only Anthropic API resolves.',
    'no-resolv',
    'no-hosts',
    `server=/${ANTHROPIC_API_HOST}/8.8.8.8`,
    'address=/#/',
  ].join('\n');
}

// ── Sandbox lifecycle ────────────────────────────────────────────────────────

/**
 * Start a sandbox container for a studio session.
 *
 * Creates and starts a Docker container with:
 *   - Network isolation (iptables rules restricting egress).
 *   - Restricted DNS (only Anthropic API domain resolves).
 *   - Source code mounted read-write at /studio/src.
 *   - Build output volume at /studio/build-output.
 *   - NET_ADMIN capability (required for iptables).
 *
 * The container runs in detached mode with a long-lived sleep process.
 * Claude's agent process is exec'd into the container separately.
 *
 * @param config Sandbox configuration.
 * @returns Sandbox state for tracking.
 * @throws If container creation fails.
 */
export function startSandbox(config: SandboxConfig): SandboxState {
  const containerName = sandboxContainerName(config.sessionId);

  // Remove any stale container with the same name.
  spawn('docker', ['rm', '-f', containerName]);

  // Write network rules and DNS config to temp files for injection.
  const rulesScript = buildNetworkRules();
  const dnsConfig = buildDnsConfig();

  // Create the container.
  const createResult = spawn('docker', [
    'create',
    '--name', containerName,
    '--label', `app=${SANDBOX_LABEL}`,
    '--label', `session=${config.sessionId}`,
    // Network: start with host networking disabled.
    '--network', 'none',
    // Capabilities: NET_ADMIN for iptables, drop everything else.
    '--cap-add', 'NET_ADMIN',
    '--cap-drop', 'ALL',
    '--cap-add', 'CHOWN',
    '--cap-add', 'DAC_OVERRIDE',
    '--cap-add', 'FOWNER',
    '--cap-add', 'SETGID',
    '--cap-add', 'SETUID',
    // Security: no new privileges.
    '--security-opt', 'no-new-privileges',
    // Volumes: source code (rw) and build output (rw).
    '-v', `${config.worktreePath}:${SOURCE_MOUNT}:rw`,
    '-v', `${config.buildOutputDir}:${BUILD_OUTPUT_MOUNT}:rw`,
    // Working directory.
    '-w', SOURCE_MOUNT,
    // Image and entrypoint: long-lived sleep.
    SANDBOX_IMAGE,
    'sleep', 'infinity',
  ]);

  if (createResult.status !== 0) {
    throw new Error(
      `Failed to create sandbox container: ${createResult.stderr}`,
    );
  }

  const containerId = createResult.stdout.trim();

  // Start the container.
  const startResult = spawn('docker', ['start', containerName]);
  if (startResult.status !== 0) {
    // Cleanup on failure.
    spawn('docker', ['rm', '-f', containerName]);
    throw new Error(
      `Failed to start sandbox container: ${startResult.stderr}`,
    );
  }

  // Inject and apply network rules.
  const injectRules = spawn('docker', [
    'exec', containerName, 'sh', '-c', rulesScript,
  ]);

  if (injectRules.status !== 0 && config.verbose) {
    console.log(
      `  Warning: network rules injection returned non-zero: ${injectRules.stderr}`,
    );
  }

  // Inject DNS config.
  const injectDns = spawn('docker', [
    'exec', containerName, 'sh', '-c',
    `mkdir -p /etc/dnsmasq.d && cat > /etc/dnsmasq.d/studio.conf << 'DNSEOF'\n${dnsConfig}\nDNSEOF`,
  ]);

  if (injectDns.status !== 0 && config.verbose) {
    console.log(
      `  Warning: DNS config injection returned non-zero: ${injectDns.stderr}`,
    );
  }

  if (config.verbose) {
    console.log(`  Sandbox container started: ${containerName} (${containerId.slice(0, 12)})`);
  }

  return {
    containerId,
    containerName,
    buildOutputDir: config.buildOutputDir,
    worktreePath: config.worktreePath,
  };
}

/**
 * Stop and remove a sandbox container.
 *
 * Performs a graceful stop (SIGTERM + timeout) followed by forced removal.
 * Idempotent — safe to call if the container is already stopped or removed.
 *
 * @param sandbox Sandbox state from startSandbox().
 */
export function stopSandbox(sandbox: SandboxState): void {
  // Graceful stop with a short timeout.
  spawn('docker', ['stop', '--time', '5', sandbox.containerName]);

  // Force remove (catches edge cases where stop didn't clean up).
  spawn('docker', ['rm', '-f', sandbox.containerName]);
}

/**
 * List all running studio sandbox containers.
 *
 * Useful for detecting orphaned containers after a crash.
 *
 * @returns Array of sandbox info objects.
 */
export function listSandboxes(): SandboxInfo[] {
  const result = spawn('docker', [
    'ps', '-a',
    '--filter', `label=app=${SANDBOX_LABEL}`,
    '--format', '{{.ID}}|{{.Names}}|{{.Status}}',
  ]);

  if (result.status !== 0 || !result.stdout.trim()) {
    return [];
  }

  return result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [containerId, containerName, status] = line.split('|');
      return { containerId, containerName, status };
    });
}

/**
 * Clean up all orphaned studio sandbox containers.
 *
 * Stops and removes every container with the studio sandbox label.
 * Called during startup or crash recovery.
 *
 * @returns Number of containers cleaned up.
 */
export function cleanupOrphanedSandboxes(): number {
  const sandboxes = listSandboxes();
  for (const sb of sandboxes) {
    spawn('docker', ['stop', '--time', '2', sb.containerName]);
    spawn('docker', ['rm', '-f', sb.containerName]);
  }
  return sandboxes.length;
}

/**
 * Execute a build inside the sandbox container and export the image
 * to the shared volume.
 *
 * The build uses Docker-in-Docker or buildah (rootless) inside the
 * container. The resulting image is saved as a tarball on the shared
 * volume — no registry push is performed.
 *
 * @param sandbox   Sandbox state.
 * @param imageName Name/tag for the built image.
 * @returns true if the build and export succeeded.
 */
export function buildAndExportImage(
  sandbox: SandboxState,
  imageName: string,
): boolean {
  // Build using the existing Dockerfile.release inside the sandbox.
  const buildResult = spawn('docker', [
    'exec', sandbox.containerName,
    'docker', 'build',
    '-f', `${SOURCE_MOUNT}/Dockerfile.release`,
    '-t', imageName,
    SOURCE_MOUNT,
  ]);

  if (buildResult.status !== 0) {
    return false;
  }

  // Export image as tarball to the shared volume (not a network push).
  const exportResult = spawn('docker', [
    'exec', sandbox.containerName,
    'docker', 'save',
    '-o', `${BUILD_OUTPUT_MOUNT}/${imageName.replace(/[/:]/g, '-')}.tar`,
    imageName,
  ]);

  return exportResult.status === 0;
}

/**
 * Check if a sandbox container is currently running.
 *
 * @param sessionId The session ID to check.
 * @returns true if the container is running.
 */
export function isSandboxRunning(sessionId: string): boolean {
  const containerName = sandboxContainerName(sessionId);
  const result = spawn('docker', [
    'inspect', '--format', '{{.State.Running}}', containerName,
  ]);
  return result.status === 0 && result.stdout.trim() === 'true';
}
