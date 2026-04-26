/**
 * Unit tests for the DebugStore (E5).
 *
 * Verifies the ring buffer, subscription notification, breadcrumb attachment,
 * unread counting, sessionStorage persistence, and clear() semantics.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { debugStore } from "../../src/lib/debug-store";

describe("debugStore", () => {
  beforeEach(() => {
    debugStore.__resetForTest();
  });

  it("records entries and exposes them via getState()", () => {
    debugStore.record({ level: "error", source: "console", message: "boom" });
    const state = debugStore.getState();
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0].message).toBe("boom");
    expect(state.entries[0].level).toBe("error");
    expect(state.unreadCount).toBe(1);
  });

  it("notifies subscribers on record", () => {
    const calls: number[] = [];
    const unsub = debugStore.subscribe((s) => calls.push(s.entries.length));
    expect(calls).toEqual([0]);
    debugStore.record({ level: "warn", source: "fetch", message: "x" });
    expect(calls).toEqual([0, 1]);
    unsub();
    debugStore.record({ level: "warn", source: "fetch", message: "y" });
    expect(calls).toEqual([0, 1]);
  });

  it("evicts oldest entries beyond capacity 500", () => {
    for (let i = 0; i < 510; i++) {
      debugStore.record({ level: "info", source: "console", message: `m${i}` });
    }
    const { entries } = debugStore.getState();
    expect(entries).toHaveLength(500);
    expect(entries[0].message).toBe("m10");
    expect(entries[499].message).toBe("m509");
  });

  it("attaches breadcrumbs to recorded entries", () => {
    debugStore.breadcrumb({ category: "route", message: "→ /studio" });
    debugStore.breadcrumb({ category: "fetch", message: "GET /api/foo" });
    debugStore.record({ level: "error", source: "fetch", message: "fail" });
    const entry = debugStore.getState().entries[0];
    expect(entry.breadcrumbs).toHaveLength(2);
    expect(entry.breadcrumbs?.[0].message).toBe("→ /studio");
  });

  it("only counts error and warn toward unreadCount", () => {
    debugStore.record({ level: "info", source: "console", message: "i" });
    debugStore.record({ level: "debug", source: "console", message: "d" });
    expect(debugStore.getState().unreadCount).toBe(0);
    debugStore.record({ level: "warn", source: "console", message: "w" });
    debugStore.record({ level: "error", source: "console", message: "e" });
    expect(debugStore.getState().unreadCount).toBe(2);
  });

  it("markAllRead resets unread count", () => {
    debugStore.record({ level: "error", source: "console", message: "e" });
    debugStore.markAllRead();
    expect(debugStore.getState().unreadCount).toBe(0);
  });

  it("clear empties entries and breadcrumbs", () => {
    debugStore.breadcrumb({ category: "route", message: "x" });
    debugStore.record({ level: "error", source: "console", message: "e" });
    debugStore.clear();
    expect(debugStore.getState().entries).toHaveLength(0);
    expect(debugStore.getBreadcrumbs()).toHaveLength(0);
    expect(debugStore.getState().unreadCount).toBe(0);
  });

  it("persists across __resetForTest via sessionStorage when not explicitly reset", () => {
    debugStore.record({ level: "error", source: "console", message: "persist" });
    const stored = sessionStorage.getItem("superfield.debugStore.v1");
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored as string) as { entries: Array<{ message: string }> };
    expect(parsed.entries[0].message).toBe("persist");
  });
});
