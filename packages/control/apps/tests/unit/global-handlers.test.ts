/**
 * Unit tests for installGlobalErrorHandlers.
 *
 * These tests dispatch real `error` and `unhandledrejection` events on the
 * test page's `window` so we exercise the production path (no mocks, no test
 * seams). The DebugStore is the verification surface.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installGlobalErrorHandlers } from "../../src/lib/global-handlers";
import { debugStore } from "../../src/lib/debug-store";

beforeEach(() => {
  debugStore.clear();
});

afterEach(() => {
  debugStore.clear();
});

describe("installGlobalErrorHandlers", () => {
  it("is idempotent — installing twice does not double-record", () => {
    installGlobalErrorHandlers();
    installGlobalErrorHandlers();
    const evt = new ErrorEvent("error", {
      message: "boom",
      filename: "f.js",
      lineno: 1,
      colno: 1,
      error: new Error("boom"),
    });
    window.dispatchEvent(evt);
    const errors = debugStore
      .getState()
      .entries.filter((e) => e.message.includes("boom"));
    expect(errors).toHaveLength(1);
  });

  it("captures uncaught errors into the DebugStore", () => {
    installGlobalErrorHandlers();
    const evt = new ErrorEvent("error", {
      message: "synthetic uncaught",
      filename: "test.js",
      lineno: 42,
      colno: 7,
      error: new Error("synthetic uncaught"),
    });
    window.dispatchEvent(evt);
    const entry = debugStore
      .getState()
      .entries.find((e) => e.message === "synthetic uncaught");
    expect(entry).toBeDefined();
    expect(entry?.level).toBe("error");
    expect(entry?.source).toBe("window");
    expect(entry?.context).toMatchObject({
      filename: "test.js",
      lineno: 42,
      colno: 7,
    });
  });

  it("captures unhandled rejections with Error reason", () => {
    installGlobalErrorHandlers();
    const reason = new Error("rejected!");
    // PromiseRejectionEvent constructor is non-portable; build via dispatch.
    const evt = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.defineProperty(evt, "reason", { value: reason, writable: false });
    Object.defineProperty(evt, "promise", {
      value: Promise.reject(reason).catch(() => {}),
      writable: false,
    });
    window.dispatchEvent(evt);
    const entry = debugStore
      .getState()
      .entries.find((e) => e.message === "rejected!");
    expect(entry).toBeDefined();
    expect(entry?.context).toMatchObject({ kind: "unhandledrejection" });
  });

  it("captures unhandled rejections with string reason", () => {
    installGlobalErrorHandlers();
    const evt = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.defineProperty(evt, "reason", {
      value: "string reason",
      writable: false,
    });
    Object.defineProperty(evt, "promise", {
      value: Promise.reject("string reason").catch(() => {}),
      writable: false,
    });
    window.dispatchEvent(evt);
    const entry = debugStore
      .getState()
      .entries.find((e) => e.message === "string reason");
    expect(entry).toBeDefined();
  });
});
