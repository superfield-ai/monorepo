/**
 * Firecracker management API client.
 *
 * Communicates with the Firecracker process over a Unix domain socket using
 * the Firecracker HTTP API (PUT/PATCH/GET over a Unix socket).
 *
 * Reference: https://github.com/firecracker-microvm/firecracker/blob/main/src/api_server/swagger/firecracker.yaml
 */

import { request as httpRequest } from "node:http";

/** Injected HTTP client for testing. */
export type ApiClient = (
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ statusCode: number; body: string }>;

/**
 * Default production API client using Node.js http over a Unix socket.
 */
export const defaultApiClient: ApiClient = (socketPath, method, path, body) => {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = httpRequest(
      {
        socketPath,
        path,
        method,
        headers: {
          Accept: "application/json",
          ...(payload !== undefined
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          resolve({ statusCode: res.statusCode ?? 0, body: data });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
};

/** Firecracker machine configuration. */
export interface MachineConfig {
  vcpu_count: number;
  mem_size_mib: number;
  smt?: boolean;
}

/** Firecracker boot source configuration. */
export interface BootSource {
  kernel_image_path: string;
  boot_args?: string;
}

/** Firecracker drive (block device) configuration. */
export interface Drive {
  drive_id: string;
  path_on_host: string;
  is_root_device: boolean;
  is_read_only: boolean;
}

/** Firecracker virtio-fs tag configuration. */
export interface VirtioFsConfig {
  tag: string;
  host_path: string;
}

/** Firecracker network interface configuration. */
export interface NetworkInterface {
  iface_id: string;
  host_dev_name: string;
  guest_mac?: string;
}

/** Firecracker snapshot save request. */
export interface SnapshotSaveRequest {
  snapshot_type: "Full" | "Diff";
  snapshot_path: string;
  mem_file_path: string;
  version?: string;
}

/** Firecracker snapshot load request. */
export interface SnapshotLoadRequest {
  snapshot_path: string;
  mem_backend: {
    backend_path: string;
    backend_type: "File" | "Uffd";
  };
  enable_diff_snapshots?: boolean;
  resume_vm?: boolean;
}

/**
 * Low-level Firecracker API wrapper.
 *
 * All methods throw on non-2xx responses.
 */
export class FirecrackerApi {
  constructor(
    private readonly socketPath: string,
    private readonly client: ApiClient = defaultApiClient,
  ) {}

  private async call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<string> {
    const { statusCode, body: responseBody } = await this.client(
      this.socketPath,
      method,
      path,
      body,
    );
    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(
        `Firecracker API ${method} ${path} returned HTTP ${statusCode}: ${responseBody}`,
      );
    }
    return responseBody;
  }

  /** Configure the guest boot source (kernel). */
  async putBootSource(config: BootSource): Promise<void> {
    await this.call("PUT", "/boot-source", config);
  }

  /** Configure a guest drive (block device). */
  async putDrive(config: Drive): Promise<void> {
    await this.call("PUT", `/drives/${config.drive_id}`, config);
  }

  /** Configure a virtio-fs filesystem tag. */
  async putVirtioFs(config: VirtioFsConfig): Promise<void> {
    await this.call("PUT", `/virtio-fs/${config.tag}`, config);
  }

  /** Configure a network interface. */
  async putNetworkInterface(config: NetworkInterface): Promise<void> {
    await this.call("PUT", `/network-interfaces/${config.iface_id}`, config);
  }

  /** Configure the machine (vCPUs, memory). */
  async putMachineConfig(config: MachineConfig): Promise<void> {
    await this.call("PUT", "/machine-config", config);
  }

  /** Start the VM instance. */
  async startInstance(): Promise<void> {
    await this.call("PUT", "/actions", { action_type: "InstanceStart" });
  }

  /** Pause the running VM (required before snapshot). */
  async pauseVm(): Promise<void> {
    await this.call("PATCH", "/vm", { state: "Paused" });
  }

  /** Resume a paused VM. */
  async resumeVm(): Promise<void> {
    await this.call("PATCH", "/vm", { state: "Resumed" });
  }

  /** Create a snapshot of the running VM. */
  async createSnapshot(req: SnapshotSaveRequest): Promise<void> {
    await this.call("PUT", "/snapshot/create", req);
  }

  /** Load a previously saved snapshot. */
  async loadSnapshot(req: SnapshotLoadRequest): Promise<void> {
    await this.call("PUT", "/snapshot/load", req);
  }

  /** Get instance info. */
  async describeInstance(): Promise<string> {
    return this.call("GET", "/");
  }
}
