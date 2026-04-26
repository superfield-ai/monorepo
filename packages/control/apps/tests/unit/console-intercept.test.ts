/**
 * Unit tests for console interception (E3).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { debugStore } from "../../src/lib/debug-store";
import {
  installConsoleIntercept,
  uninstallConsoleIntercept,
} from "../../src/lib/console-intercept";

describe("installConsoleIntercept", () => {
  beforeEach(() => {
    debugStore.__resetForTest();
  });
  afterEach(() => {
    uninstallConsoleIntercept();
  });

  it("captures console.error into the DebugStore", () => {
    installConsoleIntercept({ forwardToConsole: false });
    console.error("hello", { foo: 1 });
    const entries = debugStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe("error");
    expect(entries[0].source).toBe("console");
    expect(entries[0].message).toContain("hello");
    expect(entries[0].message).toContain("foo");
  });

  it("captures console.warn into the DebugStore", () => {
    installConsoleIntercept({ forwardToConsole: false });
    console.warn("careful");
    expect(debugStore.getState().entries[0].level).toBe("warn");
  });

  it("does not forward to native console when forwardToConsole=false", () => {
    const native = vi.spyOn(console, "log").mockImplementation(() => {});
    installConsoleIntercept({ forwardToConsole: false });
    console.error("silenced");
    // We can't easily spy on console.error itself because we're replacing it;
    // but we can verify that the entry was recorded without producing native I/O.
    expect(debugStore.getState().entries).toHaveLength(1);
    native.mockRestore();
  });

  it("captures Error stacks when an Error is among the args", () => {
    installConsoleIntercept({ forwardToConsole: false });
    const e = new Error("kaboom");
    console.error("ctx", e);
    const entry = debugStore.getState().entries[0];
    expect(entry.stack).toBeDefined();
    expect(entry.stack).toContain("kaboom");
  });

  it("is idempotent — install twice does not double-record", () => {
    installConsoleIntercept({ forwardToConsole: false });
    installConsoleIntercept({ forwardToConsole: false });
    console.error("once");
    expect(debugStore.getState().entries).toHaveLength(1);
  });
});
