/**
 * Integration tests for the tsserver-bridge JSON-RPC server.
 *
 * These tests spawn a real `tsserver-bridge` subprocess and verify that the
 * bridge correctly:
 *   1. Detects renamed symbols via `analyze`.
 *   2. Applies renames via `apply` using the TypeScript LanguageService.
 *   3. Responds to `shutdown` and exits cleanly.
 *
 * §architecture.md — Sharp subsystem (tsserver-bridge IPC protocol)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_SCRIPT = path.resolve(__dirname, "../../tsserver-bridge.ts");

// ---------------------------------------------------------------------------
// Bridge subprocess helpers
// ---------------------------------------------------------------------------

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * A minimal test harness for the tsserver-bridge subprocess.
 * Sends JSON-RPC requests and collects responses.
 */
class BridgeHarness {
  private proc: ChildProcess;
  private buffer = "";
  private seq = 0;
  private pending = new Map<
    number,
    { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }
  >();

  constructor() {
    this.proc = spawn("bun", [BRIDGE_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const { stdout, stderr } = this.proc;
    if (!stdout) throw new Error("bridge stdout not available");

    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed) as JsonRpcResponse;
          const pending = this.pending.get(msg.id);
          if (pending) {
            this.pending.delete(msg.id);
            pending.resolve(msg);
          }
        } catch {
          // ignore malformed lines
        }
      }
    });

    stderr?.on("data", () => {
      /* suppress bridge diagnostic logs in test output */
    });
  }

  send(method: string, params: unknown): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const req = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      this.pending.set(id, { resolve, reject });
      this.proc.stdin!.write(req + "\n");

      // Timeout safety net.
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`bridge request "${method}" (id=${id}) timed out`));
        }
      }, 20_000);
    });
  }

  async shutdown(): Promise<void> {
    try {
      await this.send("shutdown", {});
    } catch {
      // bridge may have already exited
    }
    await new Promise<void>((resolve) => this.proc.on("close", resolve));
  }
}

// ---------------------------------------------------------------------------
// Tests — analyze
// ---------------------------------------------------------------------------

describe("tsserver-bridge — analyze", () => {
  let bridge: BridgeHarness;

  beforeAll(() => {
    bridge = new BridgeHarness();
  });

  afterAll(async () => {
    await bridge.shutdown();
  });

  it("detects a function rename", async () => {
    const resp = await bridge.send("analyze", {
      base_content:
        "export function greet(name: string): string { return name; }",
      new_content:
        "export function hello(name: string): string { return name; }",
    });
    expect(resp.error).toBeUndefined();
    const result = resp.result as {
      renames: Array<{ old_name: string; new_name: string; kind: string }>;
    };
    expect(result.renames).toHaveLength(1);
    expect(result.renames[0]).toMatchObject({
      old_name: "greet",
      new_name: "hello",
      kind: "function",
    });
  });

  it("detects a class rename", async () => {
    const resp = await bridge.send("analyze", {
      base_content: "export class HttpClient {}",
      new_content: "export class ApiClient {}",
    });
    const result = resp.result as {
      renames: Array<{ old_name: string; new_name: string; kind: string }>;
    };
    expect(result.renames).toHaveLength(1);
    expect(result.renames[0]).toMatchObject({
      old_name: "HttpClient",
      new_name: "ApiClient",
      kind: "class",
    });
  });

  it("returns empty renames when nothing changed", async () => {
    const src = "export function greet() {}";
    const resp = await bridge.send("analyze", {
      base_content: src,
      new_content: src,
    });
    const result = resp.result as { renames: unknown[] };
    expect(result.renames).toHaveLength(0);
  });

  it("returns an error for missing params", async () => {
    const resp = await bridge.send("analyze", {});
    expect(resp.error).toBeDefined();
    expect(resp.error!.code).toBe(-32602);
  });
});

// ---------------------------------------------------------------------------
// Tests — apply
// ---------------------------------------------------------------------------

describe("tsserver-bridge — apply", () => {
  let bridge: BridgeHarness;

  beforeAll(() => {
    bridge = new BridgeHarness();
  });

  afterAll(async () => {
    await bridge.shutdown();
  });

  it("rewrites identifier occurrences", async () => {
    const resp = await bridge.send("apply", {
      content: "const x = greet(); console.log(greet());",
      renames: [{ old_name: "greet", new_name: "hello" }],
    });
    const result = resp.result as { content: string; changed: boolean };
    expect(result.changed).toBe(true);
    expect(result.content).toContain("hello");
    expect(result.content).not.toContain("greet");
  });

  it("returns changed=false when the name is not present", async () => {
    const resp = await bridge.send("apply", {
      content: "const x = 1;",
      renames: [{ old_name: "greet", new_name: "hello" }],
    });
    const result = resp.result as { content: string; changed: boolean };
    expect(result.changed).toBe(false);
    expect(result.content).toBe("const x = 1;");
  });

  it("rewrites identifier in a function declaration", async () => {
    const resp = await bridge.send("apply", {
      content: "export function greet(name: string) { return name; }",
      renames: [{ old_name: "greet", new_name: "hello" }],
    });
    const result = resp.result as { content: string; changed: boolean };
    expect(result.changed).toBe(true);
    expect(result.content).toContain("function hello");
    expect(result.content).not.toContain("function greet");
  });

  it("returns an error for missing content param", async () => {
    const resp = await bridge.send("apply", {
      renames: [],
    });
    expect(resp.error).toBeDefined();
    expect(resp.error!.code).toBe(-32602);
  });
});

// ---------------------------------------------------------------------------
// Tests — unknown method / shutdown
// ---------------------------------------------------------------------------

describe("tsserver-bridge — protocol", () => {
  it("returns method-not-found for unknown methods", async () => {
    const bridge = new BridgeHarness();
    const resp = await bridge.send("nonexistent", {});
    expect(resp.error).toBeDefined();
    expect(resp.error!.code).toBe(-32601);
    await bridge.shutdown();
  });
});
