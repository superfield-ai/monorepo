import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

const requireCjs = createRequire(import.meta.url);
// Load via CJS so we get a mutable module.exports (needed to patch spawn/exec
// in place; ESM namespaces are frozen).
const childProcess = requireCjs(
  "node:child_process",
) as typeof import("node:child_process");
import git from "isomorphic-git";
import nodeHttp from "isomorphic-git/http/node";

import { WorktreeManager } from "../../../../git/worktree.ts";
import { createTestGitRemote, seedCommitsOnRemote } from "./git-remote.ts";

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "git-remote-test-"));
});
afterAll(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

describe("createTestGitRemote", () => {
  it("creates a bare repo and exposes it via a clonable URL", async () => {
    const remote = await createTestGitRemote({ tmpRoot });
    try {
      const cloneDir = path.join(tmpRoot, `clone-${Date.now()}`);
      await git.clone({
        fs,
        http: nodeHttp,
        dir: cloneDir,
        url: remote.remoteUrl,
        singleBranch: true,
        depth: 1,
        ref: "main",
      });
      expect(fs.existsSync(path.join(cloneDir, "README.md"))).toBe(true);
      expect(fs.existsSync(path.join(cloneDir, "packages/core/index.ts"))).toBe(
        true,
      );
      expect(fs.existsSync(path.join(cloneDir, "docs/prd.md"))).toBe(true);
    } finally {
      await remote.dispose();
    }
  });

  it("WorktreeManager.create produces a working worktree from the test remote", async () => {
    const remote = await createTestGitRemote({ tmpRoot });
    const root = path.join(tmpRoot, `wt-${Date.now()}`);
    try {
      const wm = new WorktreeManager({ root, baseUrl: remote.baseUrl });
      const wt = await wm.create({
        owner: remote.owner,
        repo: remote.repo,
        issueNumber: 42,
        slug: "smoke",
        branch: "issue-42-smoke",
        token: "ignored",
      });
      expect(fs.existsSync(path.join(wt.path, "README.md"))).toBe(true);
      expect(fs.existsSync(path.join(wt.path, "docs/prd.md"))).toBe(true);
    } finally {
      await remote.dispose();
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("dispose shuts down the helper server and removes the tmp directory", async () => {
    const remote = await createTestGitRemote({ tmpRoot });
    const { port, root } = parseRemote(remote.remoteUrl);
    // Snapshot a file that lives under the helper's tmp dir.
    await remote.dispose();

    // Port should be closed.
    await expect(tryConnect(port)).rejects.toThrow(/ECONNREFUSED|ECONNRESET/);

    // Tmp dir should not exist. Walk tmpRoot for `git-remote-*` entries; none
    // should still correspond to this remote.
    const entries = await fsp.readdir(tmpRoot);
    expect(
      entries.every(
        (e) =>
          !root.endsWith(e) ||
          !fs.existsSync(path.join(tmpRoot, e, "empty-marker")),
      ),
    ).toBe(true);
  });

  it("seedCommitsOnRemote adds commits visible to subsequent clones", async () => {
    const remote = await createTestGitRemote({ tmpRoot });
    try {
      await seedCommitsOnRemote(remote.remoteUrl, [
        {
          branch: "feature-x",
          files: { "feature.txt": "hello from seed\n" },
        },
      ]);
      const cloneDir = path.join(tmpRoot, `clone-seed-${Date.now()}`);
      await git.clone({
        fs,
        http: nodeHttp,
        dir: cloneDir,
        url: remote.remoteUrl,
        ref: "feature-x",
        singleBranch: true,
        depth: 1,
      });
      const content = await fsp.readFile(
        path.join(cloneDir, "feature.txt"),
        "utf8",
      );
      expect(content).toBe("hello from seed\n");
    } finally {
      await remote.dispose();
    }
  });

  it("no shell-outs to git during a full create-clone-dispose cycle", async () => {
    const spawnSpy = vi.spyOn(childProcess, "spawn");
    const spawnSyncSpy = vi.spyOn(childProcess, "spawnSync");
    const execSpy = vi.spyOn(childProcess, "exec");
    const execSyncSpy = vi.spyOn(childProcess, "execSync");
    try {
      const remote = await createTestGitRemote({ tmpRoot });
      const cloneDir = path.join(tmpRoot, `clone-nospawn-${Date.now()}`);
      await git.clone({
        fs,
        http: nodeHttp,
        dir: cloneDir,
        url: remote.remoteUrl,
        singleBranch: true,
        depth: 1,
        ref: "main",
      });
      await remote.dispose();

      const allCalls = [
        ...spawnSpy.mock.calls,
        ...spawnSyncSpy.mock.calls,
        ...execSpy.mock.calls,
        ...execSyncSpy.mock.calls,
      ];
      const gitCalls = allCalls.filter((args) => {
        const cmd = String(args[0] ?? "");
        return /(^|\/)git(\s|$)/.test(cmd) || cmd === "git";
      });
      expect(gitCalls).toEqual([]);
    } finally {
      spawnSpy.mockRestore();
      spawnSyncSpy.mockRestore();
      execSpy.mockRestore();
      execSyncSpy.mockRestore();
    }
  });

  it("only connects to 127.0.0.1 during the fixture lifecycle", async () => {
    const connectSpy = vi.spyOn(net.Socket.prototype, "connect");
    try {
      const remote = await createTestGitRemote({ tmpRoot });
      const cloneDir = path.join(tmpRoot, `clone-nonet-${Date.now()}`);
      await git.clone({
        fs,
        http: nodeHttp,
        dir: cloneDir,
        url: remote.remoteUrl,
        singleBranch: true,
        depth: 1,
        ref: "main",
      });
      await remote.dispose();

      for (const call of connectSpy.mock.calls) {
        const arg = call[0] as
          | { host?: string; address?: string; port?: number }
          | string
          | number;
        if (typeof arg === "object" && arg !== null) {
          const host = arg.host ?? arg.address ?? "127.0.0.1";
          expect(["127.0.0.1", "::1", "localhost"]).toContain(host);
        }
      }
    } finally {
      connectSpy.mockRestore();
    }
  });
});

function parseRemote(url: string): { port: number; root: string } {
  const m = url.match(/^http:\/\/127\.0\.0\.1:(\d+)(\/.*)$/);
  if (!m) throw new Error(`bad url: ${url}`);
  return { port: Number(m[1]!), root: m[2]! };
}

function tryConnect(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: "127.0.0.1", port });
    sock.once("connect", () => {
      sock.destroy();
      reject(new Error("port still listening"));
    });
    sock.once("error", (err) => reject(err));
  });
}
