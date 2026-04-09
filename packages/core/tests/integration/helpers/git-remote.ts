/**
 * Test git remote helper.
 *
 * Stands up a bare `isomorphic-git` repository on disk and exposes it over a
 * tiny localhost smart-HTTP server so `WorktreeManager.create` can clone from
 * it exactly the way it clones from github.com in production — no network, no
 * `git` shell-outs.
 *
 * Design notes (resolved from the scout stub's open question):
 *
 * 1. `file://` URLs are **not** supported by isomorphic-git. It only registers
 *    remote helpers for `http` / `https` and throws `UnknownTransportError`
 *    for anything else. We therefore need a localhost HTTP transport.
 *
 * 2. isomorphic-git requires the **smart** HTTP protocol — it errors out if
 *    the server does not respond with `# service=git-upload-pack` and the
 *    `application/x-git-upload-pack-advertisement` content-type. Dumb HTTP
 *    is not an option.
 *
 * 3. isomorphic-git does **not** ship a server-side smart-HTTP backend, so
 *    we implement the minimal upload-pack responder inline using its
 *    primitives (`git.listBranches`, `git.resolveRef`, `git.readObject`).
 *    We only advertise what an isomorphic-git client actually uses for a
 *    shallow single-branch clone, and we only handle the "fresh clone"
 *    negotiation (`want ...` / `done`, no `have`).
 *
 * 4. The server binds to `127.0.0.1:0` (random free port). `dispose()`
 *    awaits `server.close()` and then removes the tmp directory.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import git from "isomorphic-git";

export interface TestGitRemote {
  /** Clonable URL of the form `http://127.0.0.1:<port>/<owner>/<repo>.git`. */
  remoteUrl: string;
  /** Repo base URL suitable for `new WorktreeManager({ baseUrl })`. */
  baseUrl: string;
  owner: string;
  repo: string;
  /** Shuts down the HTTP server and removes all on-disk state. */
  dispose(): Promise<void>;
}

export interface SeedCommit {
  branch: string;
  files: Record<string, string>;
}

const DEFAULT_FILES: Record<string, string> = {
  "README.md":
    "# test fixture\n\nIn-tree bare git remote for dev-loop tests.\n",
  "packages/core/index.ts": "export const marker = 'test-fixture';\n",
  "docs/prd.md":
    "# Test PRD\n\nMinimal placeholder for develop-issue prompt context.\n",
};

/**
 * Creates a bare repo on disk, seeds it with an initial commit, and exposes
 * it via a localhost smart-HTTP server. Returns a handle that the caller
 * must `dispose()` to release the port and remove the tmp directory.
 */
export async function createTestGitRemote(opts: {
  tmpRoot: string;
  owner?: string;
  repo?: string;
  files?: Record<string, string>;
}): Promise<TestGitRemote> {
  const owner = opts.owner ?? "test-owner";
  const repo = opts.repo ?? "test-repo";
  const suffix = randomBytes(4).toString("hex");
  const root = path.join(opts.tmpRoot, `git-remote-${suffix}`);
  const bareDir = path.join(root, `${owner}__${repo}.git`);
  await fsp.mkdir(bareDir, { recursive: true });

  // Initialize bare repo.
  await git.init({ fs, dir: bareDir, bare: true, defaultBranch: "main" });

  // Seed initial commit directly into the bare repo using plumbing writes.
  const files = opts.files ?? DEFAULT_FILES;
  const treeOid = await writeTreeFromFiles(bareDir, files);
  const commitOid = await git.writeCommit({
    fs,
    dir: bareDir,
    gitdir: bareDir,
    commit: {
      tree: treeOid,
      parent: [],
      author: {
        name: "Test Fixture",
        email: "fixture@superfield.test",
        timestamp: 1700000000,
        timezoneOffset: 0,
      },
      committer: {
        name: "Test Fixture",
        email: "fixture@superfield.test",
        timestamp: 1700000000,
        timezoneOffset: 0,
      },
      message: "initial fixture commit\n",
    },
  });
  await git.writeRef({
    fs,
    dir: bareDir,
    gitdir: bareDir,
    ref: "refs/heads/main",
    value: commitOid,
    force: true,
  });
  // Make sure HEAD points at main.
  await fsp.writeFile(path.join(bareDir, "HEAD"), "ref: refs/heads/main\n");

  // Build a map of repoPath -> bareDir so we can host multiple bare repos
  // behind one server if needed. For now it's just one.
  const repos = new Map<string, string>();
  const repoPath = `/${owner}/${repo}.git`;
  repos.set(repoPath, bareDir);

  const server = http.createServer((req, res) => {
    handleSmartHttp(req, res, repos).catch((err) => {
      console.error("[git-remote helper] error:", err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  const remoteUrl = `${baseUrl}${repoPath}`;

  return {
    remoteUrl,
    baseUrl,
    owner,
    repo,
    dispose: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * Clone the remote into a tmp working dir, create/checkout the requested
 * branch, write files, commit, push. Useful for tests that need a
 * pre-existing branch (e.g. an already-merged scout PR).
 */
export async function seedCommitsOnRemote(
  remoteUrl: string,
  commits: SeedCommit[],
): Promise<void> {
  const { default: nodeHttp } = await import("isomorphic-git/http/node");
  const tmpDir = await fsp.mkdtemp(
    path.join(await fsp.realpath("/tmp"), "seed-"),
  );
  try {
    await git.clone({
      fs,
      http: nodeHttp,
      dir: tmpDir,
      url: remoteUrl,
      singleBranch: false,
      depth: 1,
    });
    for (const c of commits) {
      // Create branch if missing.
      const existing = await git.listBranches({ fs, dir: tmpDir });
      if (!existing.includes(c.branch)) {
        await git.branch({ fs, dir: tmpDir, ref: c.branch, checkout: true });
      } else {
        await git.checkout({ fs, dir: tmpDir, ref: c.branch });
      }
      for (const [relPath, content] of Object.entries(c.files)) {
        const abs = path.join(tmpDir, relPath);
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, content);
        await git.add({ fs, dir: tmpDir, filepath: relPath });
      }
      await git.commit({
        fs,
        dir: tmpDir,
        message: `seed: ${c.branch}`,
        author: {
          name: "Seed",
          email: "seed@superfield.test",
          timestamp: 1700000001,
          timezoneOffset: 0,
        },
      });
      await git.push({
        fs,
        http: nodeHttp,
        dir: tmpDir,
        remote: "origin",
        ref: c.branch,
        force: true,
      });
    }
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------------------
// Smart HTTP backend
// --------------------------------------------------------------------------

async function handleSmartHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  repos: Map<string, string>,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  // Match `/owner/repo.git/<rest>`.
  const match = url.pathname.match(/^(\/[^/]+\/[^/]+\.git)(\/.*)?$/);
  if (!match) {
    res.writeHead(404);
    res.end();
    return;
  }
  const repoKey = match[1]!;
  const rest = match[2] ?? "/";
  const gitdir = repos.get(repoKey);
  if (!gitdir) {
    res.writeHead(404);
    res.end();
    return;
  }

  if (req.method === "GET" && rest === "/info/refs") {
    const service = url.searchParams.get("service");
    if (service !== "git-upload-pack") {
      // Receive-pack (push) is also needed so `seedCommitsOnRemote` can push.
      if (service !== "git-receive-pack") {
        res.writeHead(400);
        res.end();
        return;
      }
    }
    await serveInfoRefs(res, gitdir, service);
    return;
  }
  if (req.method === "POST" && rest === "/git-upload-pack") {
    await serveUploadPack(req, res, gitdir);
    return;
  }
  if (req.method === "POST" && rest === "/git-receive-pack") {
    await serveReceivePack(req, res, gitdir);
    return;
  }
  res.writeHead(404);
  res.end();
}

async function serveInfoRefs(
  res: http.ServerResponse,
  gitdir: string,
  service: string,
): Promise<void> {
  const refs = await collectRefs(gitdir);
  res.writeHead(200, {
    "content-type": `application/x-${service}-advertisement`,
    "cache-control": "no-cache",
  });
  // Pkt-line: `# service=<service>\n`, flush, then each ref.
  const chunks: Buffer[] = [];
  chunks.push(pktLine(`# service=${service}\n`));
  chunks.push(flushPkt());
  if (refs.length === 0) {
    chunks.push(flushPkt());
    res.end(Buffer.concat(chunks));
    return;
  }
  // Resolve HEAD symbolic ref target (usually refs/heads/main).
  let headTarget = "refs/heads/main";
  try {
    const headContent = (
      await fsp.readFile(path.join(gitdir, "HEAD"), "utf8")
    ).trim();
    const m = headContent.match(/^ref:\s*(.+)$/);
    if (m) headTarget = m[1]!.trim();
  } catch {
    // default
  }
  const headOid = refs.find((r) => r.name === headTarget)?.oid;
  // Prepend HEAD as the first advertised ref when it resolves.
  const advertised: { name: string; oid: string }[] = [];
  if (headOid) advertised.push({ name: "HEAD", oid: headOid });
  advertised.push(...refs);

  const caps = [
    "side-band-64k",
    "no-progress",
    "ofs-delta",
    "multi_ack_detailed",
    "no-done",
    "shallow",
    "deepen-since",
    "deepen-not",
    "deepen-relative",
    `symref=HEAD:${headTarget}`,
    "agent=superfield-test-fixture/0",
  ].join(" ");
  // First ref includes capabilities appended after a NUL byte.
  const [first, ...restRefs] = advertised;
  const firstLine = Buffer.concat([
    Buffer.from(`${first!.oid} ${first!.name}`),
    Buffer.from([0]),
    Buffer.from(`${caps}\n`),
  ]);
  chunks.push(pktLine(firstLine));
  for (const r of restRefs) {
    chunks.push(pktLine(`${r.oid} ${r.name}\n`));
  }
  chunks.push(flushPkt());
  res.end(Buffer.concat(chunks));
}

async function collectRefs(
  gitdir: string,
): Promise<{ name: string; oid: string }[]> {
  const out: { name: string; oid: string }[] = [];
  const branches = await git.listBranches({ fs, dir: gitdir, gitdir });
  for (const b of branches) {
    const oid = await git.resolveRef({
      fs,
      dir: gitdir,
      gitdir,
      ref: `refs/heads/${b}`,
    });
    out.push({ name: `refs/heads/${b}`, oid });
  }
  // Put HEAD target (main) first if present so the advertisement is stable.
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

async function serveUploadPack(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  gitdir: string,
): Promise<void> {
  const body = await readBody(req);
  const wants = parseWants(body);
  if (wants.length === 0) {
    res.writeHead(400);
    res.end("no wants");
    return;
  }
  // Collect all oids reachable from the wanted commits (shallow depth-1 is
  // still a full tree walk for the tip commit — depth controls commit
  // ancestors, not tree contents).
  const allOids = new Set<string>();
  for (const want of wants) {
    await walkCommit(gitdir, want, allOids);
  }
  const { packfile } = await git.packObjects({
    fs,
    dir: gitdir,
    gitdir,
    oids: [...allOids],
  });
  if (!packfile) throw new Error("packObjects returned no packfile");

  res.writeHead(200, {
    "content-type": "application/x-git-upload-pack-result",
    "cache-control": "no-cache",
  });

  // Shallow clones: client requested `deepen N`. We advertise every want as
  // shallow (no ancestors packed). isomorphic-git accepts shallow/unshallow
  // lines before NAK.
  const chunks: Buffer[] = [];
  const isShallow = /\bdeepen \d+\n/.test(body.toString("utf8"));
  if (isShallow) {
    for (const w of wants) chunks.push(pktLine(`shallow ${w}\n`));
    chunks.push(flushPkt());
  }
  chunks.push(pktLine("NAK\n"));
  // Mux packfile on sideband channel 1 in chunks.
  const pf = Buffer.from(packfile);
  const MAX = 65515; // leave room for the 1-byte channel marker; 65519 is spec max
  for (let off = 0; off < pf.length; off += MAX) {
    const slice = pf.subarray(off, Math.min(off + MAX, pf.length));
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  chunks.push(flushPkt());
  res.end(Buffer.concat(chunks));
}

async function serveReceivePack(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  gitdir: string,
): Promise<void> {
  const body = await readBody(req);
  // Parse pkt-line commands: `<old> <new> <ref>\0caps...\n` then flush then packfile.
  const { commands, packfile } = parseReceiveRequest(body);

  // Write packfile to objects/pack and index it via isomorphic-git's
  // indexPack so the new refs resolve.
  if (packfile && packfile.length > 0) {
    const filename = `pack-incoming-${randomBytes(8).toString("hex")}.pack`;
    const packPath = path.join(gitdir, "objects", "pack", filename);
    await fsp.mkdir(path.dirname(packPath), { recursive: true });
    await fsp.writeFile(packPath, packfile);
    await git.indexPack({
      fs,
      dir: gitdir,
      gitdir,
      filepath: `objects/pack/${filename}`,
    });
  }

  // Apply ref updates.
  const statuses: { ref: string; ok: boolean; msg?: string }[] = [];
  for (const cmd of commands) {
    try {
      if (/^0+$/.test(cmd.newOid)) {
        await git.deleteRef({ fs, dir: gitdir, gitdir, ref: cmd.ref });
      } else {
        await git.writeRef({
          fs,
          dir: gitdir,
          gitdir,
          ref: cmd.ref,
          value: cmd.newOid,
          force: true,
        });
      }
      statuses.push({ ref: cmd.ref, ok: true });
    } catch (e) {
      statuses.push({
        ref: cmd.ref,
        ok: false,
        msg: (e as Error).message,
      });
    }
  }

  res.writeHead(200, {
    "content-type": "application/x-git-receive-pack-result",
    "cache-control": "no-cache",
  });

  // Report-status response, muxed on sideband channel 1 like upload-pack.
  const inner: Buffer[] = [];
  inner.push(pktLine("unpack ok\n"));
  for (const s of statuses) {
    inner.push(
      pktLine(s.ok ? `ok ${s.ref}\n` : `ng ${s.ref} ${s.msg ?? "error"}\n`),
    );
  }
  inner.push(flushPkt());
  const innerBuf = Buffer.concat(inner);

  const outer: Buffer[] = [];
  outer.push(pktLine(Buffer.concat([Buffer.from([1]), innerBuf])));
  outer.push(flushPkt());
  res.end(Buffer.concat(outer));
}

// --------------------------------------------------------------------------
// pkt-line + parsing helpers
// --------------------------------------------------------------------------

function pktLine(payload: string | Buffer): Buffer {
  const buf = typeof payload === "string" ? Buffer.from(payload) : payload;
  const len = buf.length + 4;
  const hex = len.toString(16).padStart(4, "0");
  return Buffer.concat([Buffer.from(hex), buf]);
}

function flushPkt(): Buffer {
  return Buffer.from("0000");
}

function parseWants(body: Buffer): string[] {
  const wants: string[] = [];
  let off = 0;
  while (off + 4 <= body.length) {
    const lenHex = body.slice(off, off + 4).toString("utf8");
    const len = parseInt(lenHex, 16);
    if (len === 0) {
      off += 4;
      continue;
    }
    if (len < 4) break;
    const line = body.slice(off + 4, off + len).toString("utf8");
    off += len;
    const m = line.match(/^want ([0-9a-f]{40})/);
    if (m) wants.push(m[1]!);
    if (line.startsWith("done")) break;
  }
  return [...new Set(wants)];
}

interface ReceiveCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parseReceiveRequest(body: Buffer): {
  commands: ReceiveCommand[];
  packfile: Buffer | null;
} {
  const commands: ReceiveCommand[] = [];
  let off = 0;
  while (off + 4 <= body.length) {
    const lenHex = body.slice(off, off + 4).toString("utf8");
    const len = parseInt(lenHex, 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      off += 4;
      break; // flush before packfile
    }
    if (len < 4) break;
    let line = body.slice(off + 4, off + len).toString("utf8");
    off += len;
    // Strip trailing \n and any caps after NUL.
    line = line.replace(/\n$/, "");
    const nul = line.indexOf("\0");
    if (nul >= 0) line = line.slice(0, nul);
    const m = line.match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/);
    if (m) {
      commands.push({ oldOid: m[1]!, newOid: m[2]!, ref: m[3]! });
    }
  }
  const packfile = off < body.length ? body.slice(off) : null;
  return { commands, packfile };
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks);
  // Some clients (isomorphic-git/http/node) gzip the request body.
  const enc = req.headers["content-encoding"];
  if (enc === "gzip") return zlib.gunzipSync(raw);
  if (enc === "deflate") return zlib.inflateSync(raw);
  return raw;
}

// --------------------------------------------------------------------------
// Object graph walking + tree construction
// --------------------------------------------------------------------------

async function walkCommit(
  gitdir: string,
  commitOid: string,
  out: Set<string>,
): Promise<void> {
  if (out.has(commitOid)) return;
  out.add(commitOid);
  const { commit } = await git.readCommit({
    fs,
    dir: gitdir,
    gitdir,
    oid: commitOid,
  });
  await walkTree(gitdir, commit.tree, out);
}

async function walkTree(
  gitdir: string,
  treeOid: string,
  out: Set<string>,
): Promise<void> {
  if (out.has(treeOid)) return;
  out.add(treeOid);
  const { tree } = await git.readTree({
    fs,
    dir: gitdir,
    gitdir,
    oid: treeOid,
  });
  for (const entry of tree) {
    if (entry.type === "tree") {
      await walkTree(gitdir, entry.oid, out);
    } else {
      out.add(entry.oid);
    }
  }
}

/** Build a tree from a flat `path -> content` map by writing blobs then trees. */
async function writeTreeFromFiles(
  gitdir: string,
  files: Record<string, string>,
): Promise<string> {
  // Build a nested directory tree.
  interface Node {
    dirs: Map<string, Node>;
    blobs: Map<string, string>; // name -> oid
  }
  const root: Node = { dirs: new Map(), blobs: new Map() };
  for (const [rel, content] of Object.entries(files)) {
    const oid = await git.writeBlob({
      fs,
      dir: gitdir,
      gitdir,
      blob: Buffer.from(content),
    });
    const parts = rel.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]!;
      let child = node.dirs.get(seg);
      if (!child) {
        child = { dirs: new Map(), blobs: new Map() };
        node.dirs.set(seg, child);
      }
      node = child;
    }
    node.blobs.set(parts[parts.length - 1]!, oid);
  }
  const writeNode = async (node: Node): Promise<string> => {
    const entries: {
      mode: string;
      path: string;
      oid: string;
      type: "blob" | "tree";
    }[] = [];
    for (const [name, oid] of node.blobs) {
      entries.push({ mode: "100644", path: name, oid, type: "blob" });
    }
    for (const [name, child] of node.dirs) {
      const oid = await writeNode(child);
      entries.push({ mode: "040000", path: name, oid, type: "tree" });
    }
    return git.writeTree({ fs, dir: gitdir, gitdir, tree: entries });
  };
  return writeNode(root);
}
