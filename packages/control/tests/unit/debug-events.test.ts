/**
 * Unit tests for the backend debug-event broadcaster (E7).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetDebugEventsForTest,
  debugEventsSseResponse,
  getRecentEvents,
  logBackend,
  logBackendError,
  subscribe,
} from "../../src/debug-events";

describe("logBackend", () => {
  beforeEach(() => {
    __resetDebugEventsForTest();
  });
  afterEach(() => {
    __resetDebugEventsForTest();
  });

  it("appends to the ring buffer", () => {
    logBackend("error", "router", "boom", { context: { url: "/x" } });
    const recent = getRecentEvents();
    expect(recent).toHaveLength(1);
    expect(recent[0]!.level).toBe("error");
    expect(recent[0]!.message).toBe("boom");
    expect(recent[0]!.context).toEqual({ url: "/x" });
  });

  it("notifies live subscribers", () => {
    const calls: string[] = [];
    const unsub = subscribe((e) => calls.push(e.message));
    logBackend("warn", "router", "first");
    logBackend("error", "router", "second");
    expect(calls).toEqual(["first", "second"]);
    unsub();
    logBackend("error", "router", "third");
    expect(calls).toEqual(["first", "second"]);
  });

  it("evicts oldest entries beyond capacity 200", () => {
    for (let i = 0; i < 210; i++) logBackend("info", "x", `m${i}`);
    const recent = getRecentEvents();
    expect(recent).toHaveLength(200);
    expect(recent[0]!.message).toBe("m10");
  });
});

describe("logBackendError", () => {
  beforeEach(() => __resetDebugEventsForTest());

  it("captures Error message and stack", () => {
    logBackendError(new Error("blew up"), "test-source");
    const recent = getRecentEvents();
    expect(recent[0]!.level).toBe("error");
    expect(recent[0]!.message).toBe("blew up");
    expect(recent[0]!.source).toBe("test-source");
    expect(recent[0]!.stack).toBeDefined();
  });

  it("falls back to String(err) for non-Error values", () => {
    logBackendError("just a string", "src");
    expect(getRecentEvents()[0]!.message).toBe("just a string");
  });
});

describe("debugEventsSseResponse", () => {
  beforeEach(() => __resetDebugEventsForTest());

  it("returns a 200 text/event-stream Response", () => {
    const res = debugEventsSseResponse();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
  });

  it("replays the ring buffer to a new subscriber", async () => {
    logBackend("error", "src", "history-1");
    logBackend("warn", "src", "history-2");
    const res = debugEventsSseResponse();
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let combined = "";
    for (let i = 0; i < 2; i++) {
      const chunk = await reader.read();
      if (chunk.value) combined += decoder.decode(chunk.value);
    }
    expect(combined).toContain("history-1");
    expect(combined).toContain("history-2");
    await reader.cancel();
  });
});
