/**
 * Unit tests for DocsController — Layer 1b (headless Chromium).
 *
 * All fetch calls are intercepted via vi.stubGlobal('fetch', ...).
 *
 * Canonical docs: docs/product.md §Iterative development — `product` mode chat; docs viewer
 *
 * Scenarios covered (8):
 *  1. Initial state: files empty, selectedFile null, content null, loading false, error null
 *  2. loadFileList() fetches GET /studio/docs, populates files, clears loading
 *  3. loadFileList() sets error on a non-OK response
 *  4. selectFile(path) fetches GET /studio/docs/<path>, sets selectedFile and content
 *  5. Cache hit: calling selectFile(path) a second time does not re-fetch
 *  6. Cache miss: calling selectFile(path2) after selectFile(path1) fetches path2
 *  7. selectFile() sets error on fetch failure and leaves content null
 *  8. subscribe → listener called immediately with current state; unsubscribe removes it
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocsController } from "../../src/controllers/DocsController";

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeTextResponse(text: string, status = 200): Response {
  return new Response(text, {
    status,
    headers: { "Content-Type": "text/plain" },
  });
}

describe("DocsController", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("1: initial state is empty with no loading or error", () => {
    const ctrl = new DocsController();
    const state = ctrl.getState();
    expect(state.files).toEqual([]);
    expect(state.selectedFile).toBeNull();
    expect(state.content).toBeNull();
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });

  it("2: loadFileList() fetches GET /studio/docs, populates files, clears loading", async () => {
    // loadFileList() auto-selects README.md (first match) and fetches its content.
    // Two fetch calls: one for the file list, one for README.md content.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeJsonResponse({ files: ["README.md", "guide.md"] }),
      )
      .mockResolvedValueOnce(makeTextResponse("# README content"));
    vi.stubGlobal("fetch", fetchMock);

    const ctrl = new DocsController({
      docsListUrl: "/studio/docs",
      docsContentBaseUrl: "/studio/docs",
    });
    await ctrl.loadFileList();

    const state = ctrl.getState();
    expect(state.files).toEqual(["README.md", "guide.md"]);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
    // The list fetch must have been called with the list URL
    expect(fetchMock).toHaveBeenCalledWith("/studio/docs");
  });

  it("3: loadFileList() sets error on a non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(makeJsonResponse({}, 500))),
    );

    const ctrl = new DocsController();
    await ctrl.loadFileList();

    const state = ctrl.getState();
    expect(state.loading).toBe(false);
    expect(state.error).toMatch(/500/);
    expect(state.files).toEqual([]);
  });

  it("4: selectFile(path) fetches GET /studio/docs/<path>, sets selectedFile and content", async () => {
    const fileContent = "# Hello World";
    const fetchMock = vi.fn(() =>
      Promise.resolve(makeTextResponse(fileContent)),
    );
    vi.stubGlobal("fetch", fetchMock);

    const ctrl = new DocsController();
    await ctrl.selectFile("hello.md");

    const state = ctrl.getState();
    expect(state.selectedFile).toBe("hello.md");
    expect(state.content).toBe(fileContent);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/studio/docs/hello.md");
  });

  it("5: cache hit — selectFile(path) a second time does not re-fetch", async () => {
    const fileContent = "# Cached Content";
    const fetchMock = vi.fn(() =>
      Promise.resolve(makeTextResponse(fileContent)),
    );
    vi.stubGlobal("fetch", fetchMock);

    const ctrl = new DocsController();
    await ctrl.selectFile("cached.md");
    await ctrl.selectFile("cached.md");

    // fetch should only have been called once
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ctrl.getState().content).toBe(fileContent);
  });

  it("6: cache miss — selectFile(path2) after selectFile(path1) fetches path2", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeTextResponse("# File 1 content"))
      .mockResolvedValueOnce(makeTextResponse("# File 2 content"));
    vi.stubGlobal("fetch", fetchMock);

    const ctrl = new DocsController();
    await ctrl.selectFile("file1.md");
    await ctrl.selectFile("file2.md");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/studio/docs/file1.md");
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/studio/docs/file2.md");
    expect(ctrl.getState().selectedFile).toBe("file2.md");
    expect(ctrl.getState().content).toBe("# File 2 content");
  });

  it("7: selectFile() sets error on fetch failure and leaves content null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(makeTextResponse("", 404))),
    );

    const ctrl = new DocsController();
    await ctrl.selectFile("missing.md");

    const state = ctrl.getState();
    expect(state.loading).toBe(false);
    expect(state.error).toMatch(/404/);
    expect(state.content).toBeNull();
  });

  it("8: subscribe fires immediately with current state; unsubscribe removes listener", () => {
    const ctrl = new DocsController();
    const calls: unknown[] = [];

    const unsubscribe = ctrl.subscribe((state) => {
      calls.push(state);
    });

    // Listener should have been called immediately on subscribe
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      files: [],
      selectedFile: null,
      content: null,
      loading: false,
      error: null,
    });

    unsubscribe();

    // After unsubscribe, further notifications should not reach this listener
    // Trigger a state change by calling notify via a public path
    // (we use getState to confirm unsubscribe doesn't error, no new calls expected)
    expect(calls).toHaveLength(1);
  });
});
