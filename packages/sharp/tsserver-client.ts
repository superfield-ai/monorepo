/**
 * TsserverClient — orchestrates the TypeScript language server (`tsserver`)
 * as a subprocess to enumerate rename locations and gather semantic
 * diagnostics for TypeScript source files.
 *
 * Protocol: tsserver reads newline-terminated JSON requests on stdin and
 * writes length-prefixed JSON responses/events on stdout.  Each request line
 * has the form:
 *
 *   {"seq":<n>,"type":"request","command":"<cmd>","arguments":{...}}
 *
 * Each response/event on stdout is framed with a blank line followed by a
 * Content-Length header line and another blank line, then the JSON body:
 *
 *   \n
 *   Content-Length: <byteLength>\n
 *   \n
 *   <JSON>\n
 *
 * See:
 *   https://github.com/microsoft/TypeScript/wiki/Standalone-Server-%28tsserver%29
 *
 * §architecture.md — Sharp subsystem (language-server-backed analysis)
 */

import { spawn, ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

/** A file position (1-based line and offset within that line). */
export interface FilePosition {
  file: string;
  line: number;
  /** 1-based character offset within the line. */
  offset: number;
}

/** One rename span returned by tsserver. */
export interface RenameLocation {
  file: string;
  start: { line: number; offset: number };
  end: { line: number; offset: number };
}

/**
 * The result of a rename query.  `canRename` is false when tsserver reports
 * that the symbol at the requested position is not renameable.
 */
export interface RenameResult {
  canRename: boolean;
  locations: RenameLocation[];
}

/** A single diagnostic (error, warning, suggestion) from tsserver. */
export interface TsDiagnostic {
  file: string;
  start: { line: number; offset: number };
  end: { line: number; offset: number };
  /** The TypeScript error code, e.g. 2322. */
  code: number;
  /** Human-readable error text. */
  text: string;
  /** Diagnostic category: "error", "warning", or "suggestion". */
  category: string;
}

export interface TsserverClientOptions {
  /**
   * Absolute path to the `tsserver` binary.
   * Defaults to the `tsserver` found relative to the `typescript` package
   * resolved from this module's own `node_modules` tree.
   */
  tsserverPath?: string;
  /** Working directory passed to the tsserver process. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Maximum milliseconds to wait for a tsserver response. Defaults to 30 000. */
  timeoutMs?: number;
}

interface PendingRequest {
  resolve: (body: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Manages the lifecycle of a single `tsserver` subprocess and exposes
 * high-level methods for rename enumeration and semantic diagnostics.
 */
export class TsserverClient {
  private readonly tsserverPath: string;
  private readonly cwd: string;
  private readonly timeoutMs: number;

  private proc: ChildProcess | null = null;
  private seq = 0;
  private pending = new Map<number, PendingRequest>();
  /** Accumulated stdout data not yet parsed into a complete message. */
  private buffer = "";

  constructor(options: TsserverClientOptions = {}) {
    this.tsserverPath = options.tsserverPath ?? resolveTsserver();
    this.cwd = options.cwd ?? process.cwd();
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** Start the tsserver subprocess. Must be called before any other method. */
  start(): void {
    if (this.proc) throw new Error("TsserverClient already started");

    this.proc = spawn(this.tsserverPath, [], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout!.setEncoding("utf8");
    this.proc.stdout!.on("data", (chunk: string) => this.onData(chunk));

    this.proc.stderr!.on("data", () => {
      /* tsserver writes startup noise to stderr — ignore */
    });

    this.proc.on("error", (err) => {
      this.rejectAll(err);
    });

    this.proc.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        this.rejectAll(new Error(`tsserver exited with code ${code}`));
      }
    });
  }

  /** Terminate the tsserver subprocess and release all resources. */
  async stop(): Promise<void> {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    proc.kill();
    await new Promise<void>((resolve) => proc.on("close", resolve));
    this.rejectAll(new Error("TsserverClient stopped"));
  }

  /**
   * Notify tsserver that a file is open and provide its content.
   * Must be called before issuing rename or diagnostic requests for that file.
   */
  openFile(filePath: string): void {
    const fileContent = fs.readFileSync(filePath, "utf8");
    this.sendRequest("open", {
      file: filePath,
      fileContent,
      scriptKindName: "TS",
    });
    // `open` is a notification — tsserver sends no response.
  }

  /**
   * Notify tsserver that a file has been closed and its content is no longer
   * held in memory.
   */
  closeFile(filePath: string): void {
    this.sendRequest("close", { file: filePath });
    // `close` is also a notification.
  }

  /**
   * Return all rename locations for the symbol at the given position.
   *
   * `filePath` must have been opened with `openFile` first.
   */
  async getRenameLocations(
    filePath: string,
    line: number,
    offset: number,
  ): Promise<RenameResult> {
    const body = await this.request("rename", {
      file: filePath,
      line,
      offset,
      findInComments: false,
      findInStrings: false,
    });

    const resp = body as {
      info: { canRename: boolean };
      locs: Array<{
        file: string;
        locs: Array<{
          start: { line: number; offset: number };
          end: { line: number; offset: number };
        }>;
      }>;
    };

    if (!resp.info.canRename) {
      return { canRename: false, locations: [] };
    }

    const locations: RenameLocation[] = [];
    for (const fileGroup of resp.locs) {
      for (const loc of fileGroup.locs) {
        locations.push({
          file: fileGroup.file,
          start: loc.start,
          end: loc.end,
        });
      }
    }

    return { canRename: true, locations };
  }

  /**
   * Return semantic diagnostics for the given file.
   *
   * `filePath` must have been opened with `openFile` first.
   */
  async getSemanticDiagnostics(filePath: string): Promise<TsDiagnostic[]> {
    const body = await this.request("semanticDiagnosticsSync", {
      file: filePath,
    });

    const diags = body as Array<{
      start: { line: number; offset: number };
      end: { line: number; offset: number };
      code: number;
      text: string;
      category: string;
    }>;

    if (!Array.isArray(diags)) return [];

    return diags.map((d) => ({
      file: filePath,
      start: d.start,
      end: d.end,
      code: d.code,
      text: d.text,
      category: d.category,
    }));
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Send a request that expects a response and return a promise that resolves
   * with the response body.
   */
  private request(command: string, args: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const seq = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(
          new Error(`tsserver request "${command}" (seq=${seq}) timed out`),
        );
      }, this.timeoutMs);

      this.pending.set(seq, { resolve, reject, timer });
      this.sendRaw(seq, command, args);
    });
  }

  /**
   * Send a notification (a request that produces no response from tsserver).
   * We still increment seq for consistency but don't register a pending entry.
   */
  private sendRequest(command: string, args: unknown): void {
    this.sendRaw(++this.seq, command, args);
  }

  private sendRaw(seq: number, command: string, args: unknown): void {
    if (!this.proc) throw new Error("TsserverClient not started");
    const msg = JSON.stringify({
      seq,
      type: "request",
      command,
      arguments: args,
    });
    this.proc.stdin!.write(msg + "\n");
  }

  /**
   * Parse the length-framed tsserver stdout into discrete messages.
   * The format is:
   *
   *   Content-Length: <N>\r\n
   *   \r\n
   *   <N bytes of JSON>\n
   *
   * Multiple messages may arrive in one `data` event; we accumulate them in
   * `this.buffer` and extract complete messages one at a time.
   */
  private onData(chunk: string): void {
    this.buffer += chunk;

    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = this.buffer.slice(0, headerEnd);
      const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        // Unexpected header format — skip past it.
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const bodyLength = parseInt(lengthMatch[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + bodyLength) {
        // Wait for more data.
        break;
      }

      const body = this.buffer.slice(bodyStart, bodyStart + bodyLength);
      this.buffer = this.buffer.slice(bodyStart + bodyLength);

      try {
        const msg = JSON.parse(body) as {
          type: string;
          request_seq?: number;
          success?: boolean;
          body?: unknown;
          message?: string;
        };
        this.onMessage(msg);
      } catch {
        // Malformed JSON from tsserver — ignore.
      }
    }
  }

  private onMessage(msg: {
    type: string;
    request_seq?: number;
    success?: boolean;
    body?: unknown;
    message?: string;
  }): void {
    if (msg.type !== "response" || msg.request_seq === undefined) return;

    const pending = this.pending.get(msg.request_seq);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(msg.request_seq);

    if (msg.success === false) {
      pending.reject(
        new Error(msg.message ?? `tsserver error for seq=${msg.request_seq}`),
      );
    } else {
      pending.resolve(msg.body);
    }
  }

  private rejectAll(err: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }
}

/**
 * Resolve the path to the `tsserver` binary shipped with the `typescript`
 * package that is on the module resolution path from this file.
 */
function resolveTsserver(): string {
  // Walk up from this file's directory to find node_modules/typescript/bin/tsserver
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(
      dir,
      "node_modules",
      "typescript",
      "bin",
      "tsserver",
    );
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fall back to PATH lookup.
  return "tsserver";
}
