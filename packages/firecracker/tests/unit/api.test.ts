/**
 * Unit tests for the Firecracker API client.
 *
 * Uses an injected ApiClient stub — no real socket or Firecracker process needed.
 */

import { describe, it, expect, vi } from "vitest";
import { FirecrackerApi } from "../../api.ts";
import type { ApiClient } from "../../api.ts";

/** Build an API client stub that always returns 204. */
function successClient(): ApiClient {
  return vi.fn().mockResolvedValue({ statusCode: 204, body: "" });
}

/** Build an API client stub that returns an error status. */
function errorClient(statusCode: number, body = "error"): ApiClient {
  return vi.fn().mockResolvedValue({ statusCode, body });
}

describe("FirecrackerApi", () => {
  const SOCKET = "/tmp/test.sock";

  describe("putBootSource", () => {
    it("sends PUT /boot-source with kernel config", async () => {
      const client = successClient();
      const api = new FirecrackerApi(SOCKET, client);

      await api.putBootSource({
        kernel_image_path: "/path/to/vmlinux.bin",
        boot_args: "console=ttyS0 pci=off",
      });

      expect(client).toHaveBeenCalledWith(
        SOCKET,
        "PUT",
        "/boot-source",
        expect.objectContaining({ kernel_image_path: "/path/to/vmlinux.bin" }),
      );
    });

    it("throws on non-2xx response", async () => {
      const api = new FirecrackerApi(SOCKET, errorClient(400, "bad request"));
      await expect(
        api.putBootSource({ kernel_image_path: "/vmlinux.bin" }),
      ).rejects.toThrow("HTTP 400");
    });
  });

  describe("putDrive", () => {
    it("sends PUT /drives/<id> with drive config", async () => {
      const client = successClient();
      const api = new FirecrackerApi(SOCKET, client);

      await api.putDrive({
        drive_id: "rootfs",
        path_on_host: "/path/to/rootfs.ext4",
        is_root_device: true,
        is_read_only: false,
      });

      expect(client).toHaveBeenCalledWith(
        SOCKET,
        "PUT",
        "/drives/rootfs",
        expect.objectContaining({ drive_id: "rootfs", is_root_device: true }),
      );
    });
  });

  describe("putMachineConfig", () => {
    it("sends PUT /machine-config with vcpu and mem", async () => {
      const client = successClient();
      const api = new FirecrackerApi(SOCKET, client);

      await api.putMachineConfig({ vcpu_count: 2, mem_size_mib: 1024 });

      expect(client).toHaveBeenCalledWith(SOCKET, "PUT", "/machine-config", {
        vcpu_count: 2,
        mem_size_mib: 1024,
      });
    });
  });

  describe("startInstance", () => {
    it("sends PUT /actions with InstanceStart", async () => {
      const client = successClient();
      const api = new FirecrackerApi(SOCKET, client);

      await api.startInstance();

      expect(client).toHaveBeenCalledWith(SOCKET, "PUT", "/actions", {
        action_type: "InstanceStart",
      });
    });
  });

  describe("pauseVm / resumeVm", () => {
    it("sends PATCH /vm with Paused state", async () => {
      const client = successClient();
      const api = new FirecrackerApi(SOCKET, client);

      await api.pauseVm();

      expect(client).toHaveBeenCalledWith(SOCKET, "PATCH", "/vm", {
        state: "Paused",
      });
    });

    it("sends PATCH /vm with Resumed state", async () => {
      const client = successClient();
      const api = new FirecrackerApi(SOCKET, client);

      await api.resumeVm();

      expect(client).toHaveBeenCalledWith(SOCKET, "PATCH", "/vm", {
        state: "Resumed",
      });
    });
  });

  describe("createSnapshot", () => {
    it("sends PUT /snapshot/create with Full type and paths", async () => {
      const client = successClient();
      const api = new FirecrackerApi(SOCKET, client);

      await api.createSnapshot({
        snapshot_type: "Full",
        snapshot_path: "/snapshots/snapshot.vmstate",
        mem_file_path: "/snapshots/snapshot.mem",
      });

      expect(client).toHaveBeenCalledWith(
        SOCKET,
        "PUT",
        "/snapshot/create",
        expect.objectContaining({
          snapshot_type: "Full",
          snapshot_path: "/snapshots/snapshot.vmstate",
          mem_file_path: "/snapshots/snapshot.mem",
        }),
      );
    });
  });

  describe("loadSnapshot", () => {
    it("sends PUT /snapshot/load with correct request shape", async () => {
      const client = successClient();
      const api = new FirecrackerApi(SOCKET, client);

      await api.loadSnapshot({
        snapshot_path: "/snapshots/snapshot.vmstate",
        mem_backend: {
          backend_path: "/snapshots/snapshot.mem",
          backend_type: "File",
        },
        resume_vm: true,
      });

      expect(client).toHaveBeenCalledWith(
        SOCKET,
        "PUT",
        "/snapshot/load",
        expect.objectContaining({
          snapshot_path: "/snapshots/snapshot.vmstate",
          resume_vm: true,
        }),
      );
    });
  });

  describe("buildVmSnapshot — API call order", () => {
    it("calls API endpoints in correct boot sequence", async () => {
      const calls: string[] = [];
      const orderedClient: ApiClient = vi
        .fn()
        .mockImplementation(
          async (_sock: string, method: string, path: string) => {
            calls.push(`${method} ${path}`);
            return { statusCode: 204, body: "" };
          },
        );

      const api = new FirecrackerApi(SOCKET, orderedClient);

      await api.putBootSource({ kernel_image_path: "/vmlinux.bin" });
      await api.putDrive({
        drive_id: "rootfs",
        path_on_host: "/rootfs.ext4",
        is_root_device: true,
        is_read_only: false,
      });
      await api.putMachineConfig({ vcpu_count: 2, mem_size_mib: 1024 });
      await api.startInstance();
      await api.pauseVm();
      await api.createSnapshot({
        snapshot_type: "Full",
        snapshot_path: "/snap.vmstate",
        mem_file_path: "/snap.mem",
      });

      expect(calls).toEqual([
        "PUT /boot-source",
        "PUT /drives/rootfs",
        "PUT /machine-config",
        "PUT /actions",
        "PATCH /vm",
        "PUT /snapshot/create",
      ]);
    });
  });
});
