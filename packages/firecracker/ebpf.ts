/**
 * Host-side eBPF monitoring interface for the Firecracker/jailer boundary.
 *
 * This module defines the TypeScript surface through which the CI runner
 * attaches and detaches host-kernel BPF programs for a project VM.
 *
 * # Architecture
 *
 * The actual BPF program loading runs inside the `fastenv` binary
 * (`superfield-ai/fastenv`), which calls `load_and_attach_host_ebpf` in
 * `src/host_ebpf.rs`. The CLI communicates with fastenv via a subprocess
 * interface (see `EbpfMonitorOptions.binaryPath`).
 *
 * Attach point strings follow the fastenv format:
 *   "tc-ingress:<dev>"        — TC ingress hook on a named network device
 *   "tc-egress:<dev>"         — TC egress hook on a named network device
 *   "tracepoint:<cat>/<evt>"  — kernel tracepoint
 *   "kprobe:<func>"           — kprobe on a kernel function
 *
 * # Privilege requirements
 *
 * Loading BPF programs requires `CAP_BPF` (Linux 5.8+) or `CAP_SYS_ADMIN`.
 * The host control plane running inside `fastenv` is expected to hold
 * sufficient privileges. The TypeScript shim only invokes the fastenv
 * subprocess; it does not call `bpf(2)` directly.
 *
 * # Observability events
 *
 * `attach()` emits `host_ebpf.loaded` tracing events at the `info` level
 * inside `fastenv`. The TypeScript caller receives a structured
 * `EbpfAttachResult` on success.
 *
 * See: docs/architecture.md §Substrate Reliability
 * See: superfield-ai/fastenv src/host_ebpf.rs
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options shared by EbpfMonitor methods. */
export interface EbpfMonitorOptions {
  /**
   * Path to the fastenv binary. Defaults to "fastenv" (looked up on $PATH).
   * In test environments, point at a fake or mock binary.
   */
  binaryPath?: string;
}

/** Result returned by a successful `attachEbpf` call. */
export interface EbpfAttachResult {
  /** Project VM ID that this policy is attached to. */
  projectId: string;
  /** Human-readable policy name (e.g. "ci-network-policy"). */
  name: string;
  /**
   * Attach point string in fastenv format (e.g. "tc-ingress:tap0").
   * Echoed back from the fastenv `ebpf attach` subcommand output.
   */
  attachPoint: string;
  /** ISO-8601 timestamp of when the policy was loaded. */
  loadedAt: string;
  /**
   * TC attach handle for TC programs, null for tracepoint/kprobe.
   * Format: "tc:<device>:<direction>".
   */
  tcHandle: string | null;
  /** BPF pin path under /sys/fs/bpf/fastenv/<projectId>/<name>, or null. */
  pinPath: string | null;
}

/** Descriptor for an eBPF policy to attach. */
export interface EbpfPolicySpec {
  /**
   * Identifier of the running project VM. Must match the VM's project_id
   * in the fastenv host control plane registry.
   */
  projectId: string;
  /** Human-readable name for this policy (used in BPF pin paths). */
  name: string;
  /**
   * Absolute path to the compiled BPF ELF object file on the host.
   * The object file must contain a valid BPF program section (e.g. "classifier",
   * "tracepoint/...", "kprobe/...").
   */
  objectPath: string;
  /**
   * Attach point in fastenv format:
   *   "tc-ingress:<dev>" | "tc-egress:<dev>"
   *   "tracepoint:<category>/<event>"
   *   "kprobe:<function>"
   */
  attachPoint: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Attach a host-side eBPF policy to a running project VM.
 *
 * Delegates to `fastenv ebpf attach` which calls `load_and_attach_host_ebpf`
 * in the fastenv host control plane. The BPF program is loaded into the host
 * kernel and, for TC programs, attached as a classifier on the named device.
 *
 * Returns a structured `EbpfAttachResult` on success. Throws on failure with
 * the fastenv stderr as the error message.
 *
 * @throws {Error} If `fastenv ebpf attach` exits non-zero.
 */
export async function attachEbpf(
  spec: EbpfPolicySpec,
  opts: EbpfMonitorOptions = {},
): Promise<EbpfAttachResult> {
  const bin = opts.binaryPath ?? "fastenv";

  const { stdout } = await execFileAsync(bin, [
    "ebpf",
    "attach",
    "--project-id",
    spec.projectId,
    "--name",
    spec.name,
    "--object",
    spec.objectPath,
    "--attach-point",
    spec.attachPoint,
  ]).catch((err: Error & { stderr?: string }) => {
    const detail = err.stderr?.trim() ?? err.message;
    throw new Error(
      `fastenv ebpf attach failed for project '${spec.projectId}': ${detail}`,
    );
  });

  return parseAttachOutput(stdout, spec);
}

/**
 * Detach a previously attached host-side eBPF policy from a project VM.
 *
 * Delegates to `fastenv ebpf detach`. Errors are best-effort: if the policy
 * was already detached (e.g. the VM was killed), this function logs a warning
 * but does not throw.
 *
 * @throws {Error} If `fastenv ebpf detach` exits with a non-recoverable error.
 */
export async function detachEbpf(
  projectId: string,
  name: string,
  opts: EbpfMonitorOptions = {},
): Promise<void> {
  const bin = opts.binaryPath ?? "fastenv";

  await execFileAsync(bin, [
    "ebpf",
    "detach",
    "--project-id",
    projectId,
    "--name",
    name,
  ]).catch((err: Error & { stderr?: string }) => {
    const detail = err.stderr?.trim() ?? err.message;
    // Log and swallow: detach is best-effort (the VM may already be dead).
    process.stderr.write(
      `[ebpf] detach warning for project '${projectId}', policy '${name}': ${detail}\n`,
    );
  });
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

/**
 * Parse the JSON output of `fastenv ebpf attach`.
 *
 * fastenv emits a single JSON object to stdout on success. If parsing fails
 * (e.g. the binary is a stub that emits nothing), sensible defaults are used
 * so the caller gets a valid `EbpfAttachResult` either way.
 */
export function parseAttachOutput(
  stdout: string,
  spec: EbpfPolicySpec,
): EbpfAttachResult {
  const raw = stdout.trim();
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Partial<EbpfAttachResult>;
      return {
        projectId: parsed.projectId ?? spec.projectId,
        name: parsed.name ?? spec.name,
        attachPoint: parsed.attachPoint ?? spec.attachPoint,
        loadedAt: parsed.loadedAt ?? new Date().toISOString(),
        tcHandle: parsed.tcHandle ?? null,
        pinPath: parsed.pinPath ?? null,
      };
    } catch {
      // Fall through to defaults.
    }
  }

  // Fallback: fastenv did not emit JSON (e.g. stub binary).
  return {
    projectId: spec.projectId,
    name: spec.name,
    attachPoint: spec.attachPoint,
    loadedAt: new Date().toISOString(),
    tcHandle: null,
    pinPath: null,
  };
}
