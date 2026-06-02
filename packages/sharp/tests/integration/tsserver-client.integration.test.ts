/**
 * Integration tests for TsserverClient.
 *
 * These tests spawn a real `tsserver` subprocess and verify that Sharp can:
 *  1. Enumerate rename locations for a symbol in a TypeScript fixture.
 *  2. Surface semantic diagnostics for a broken TypeScript fixture.
 *
 * §architecture.md — Sharp subsystem (language-server-backed analysis)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { TsserverClient } from "../../tsserver-client.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");

/**
 * Walk upward from the fixtures directory to find the tsserver binary that was
 * installed as part of the `typescript` devDependency.
 */
function resolveTsserver(): string {
  const candidates = [
    // Bun workspaces hoist node_modules to the repo root.
    path.resolve(__dirname, "../../../../node_modules/typescript/bin/tsserver"),
    path.resolve(
      __dirname,
      "../../../../../node_modules/typescript/bin/tsserver",
    ),
    // Development machine fallback (main cli checkout).
    "/home/lucas/superfield/cli/node_modules/typescript/bin/tsserver",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return "tsserver"; // fall back to PATH
}

const TSSERVER_PATH = resolveTsserver();

// ---------------------------------------------------------------------------
// Rename location enumeration
// ---------------------------------------------------------------------------

describe("TsserverClient — rename enumeration", () => {
  let client: TsserverClient;
  const fixturePath = path.join(FIXTURES_DIR, "rename-fixture.ts");

  beforeAll(() => {
    client = new TsserverClient({
      tsserverPath: TSSERVER_PATH,
      cwd: FIXTURES_DIR,
      timeoutMs: 30_000,
    });
    client.start();
    client.openFile(fixturePath);
  });

  afterAll(async () => {
    client.closeFile(fixturePath);
    await client.stop();
  });

  it("returns canRename=true for the `greet` function symbol", async () => {
    // rename-fixture.ts line 4: "function greet(name: string): string {"
    // The `g` of `greet` is at offset 10.
    const result = await client.getRenameLocations(fixturePath, 4, 10);
    expect(result.canRename).toBe(true);
  });

  it("returns at least two locations (definition + call site)", async () => {
    const result = await client.getRenameLocations(fixturePath, 4, 10);
    expect(result.locations.length).toBeGreaterThanOrEqual(2);
  });

  it("each location references the fixture file", async () => {
    const result = await client.getRenameLocations(fixturePath, 4, 10);
    for (const loc of result.locations) {
      expect(loc.file).toBe(fixturePath);
    }
  });

  it("each location has valid start/end positions", async () => {
    const result = await client.getRenameLocations(fixturePath, 4, 10);
    for (const loc of result.locations) {
      expect(loc.start.line).toBeGreaterThan(0);
      expect(loc.start.offset).toBeGreaterThan(0);
      expect(loc.end.line).toBeGreaterThanOrEqual(loc.start.line);
    }
  });
});

// ---------------------------------------------------------------------------
// Semantic diagnostics
// ---------------------------------------------------------------------------

describe("TsserverClient — semantic diagnostics", () => {
  let client: TsserverClient;
  const fixturePath = path.join(FIXTURES_DIR, "error-fixture.ts");

  beforeAll(() => {
    client = new TsserverClient({
      tsserverPath: TSSERVER_PATH,
      cwd: FIXTURES_DIR,
      timeoutMs: 30_000,
    });
    client.start();
    client.openFile(fixturePath);
  });

  afterAll(async () => {
    client.closeFile(fixturePath);
    await client.stop();
  });

  it("returns at least one diagnostic for the broken fixture", async () => {
    const diags = await client.getSemanticDiagnostics(fixturePath);
    expect(diags.length).toBeGreaterThan(0);
  });

  it("reports a TS2345 (argument type mismatch) error", async () => {
    const diags = await client.getSemanticDiagnostics(fixturePath);
    const ts2345 = diags.find((d) => d.code === 2345);
    expect(ts2345).toBeDefined();
  });

  it("the TS2345 diagnostic category is 'error'", async () => {
    const diags = await client.getSemanticDiagnostics(fixturePath);
    const ts2345 = diags.find((d) => d.code === 2345);
    expect(ts2345?.category).toBe("error");
  });

  it("each diagnostic has a non-empty text message", async () => {
    const diags = await client.getSemanticDiagnostics(fixturePath);
    for (const d of diags) {
      expect(typeof d.text).toBe("string");
      expect(d.text.length).toBeGreaterThan(0);
    }
  });

  it("each diagnostic carries the fixture file path", async () => {
    const diags = await client.getSemanticDiagnostics(fixturePath);
    for (const d of diags) {
      expect(d.file).toBe(fixturePath);
    }
  });
});
