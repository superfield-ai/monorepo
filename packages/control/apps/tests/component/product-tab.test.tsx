/**
 * Component tests for ProductTab.
 *
 * Covers the docs viewer and the product chat surface using CLI-shaped
 * Claude fixture output as the assistant message source.
 */

import React from "react";
import { render } from "vitest-browser-react";
import { afterEach, expect, test, vi } from "vitest";
import { ProductTab } from "../../src/components/ProductTab";
import type {
  DocsController,
  DocsState,
} from "../../src/controllers/DocsController";
import type {
  WsChatController,
  WsChatControllerState,
} from "../../src/controllers/ChatController";
import { loadClaudeOutput } from "../helpers/claude-fixtures";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makeFakeWebSocket(
  framesBySend: readonly {
    type: "chunk" | "done" | "error";
    text?: string;
    message?: string;
  }[][],
) {
  return class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readonly sent: string[] = [];
    readyState = FakeWebSocket.CONNECTING;
    private readonly listeners = new Map<string, Set<(ev: unknown) => void>>();
    private sendCount = 0;

    constructor(readonly url: string) {
      queueMicrotask(() => {
        this.readyState = FakeWebSocket.OPEN;
        this.dispatch("open", {});
      });
    }

    addEventListener(type: string, listener: (ev: unknown) => void) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type)?.add(listener);
    }

    removeEventListener(type: string, listener: (ev: unknown) => void) {
      this.listeners.get(type)?.delete(listener);
    }

    send(data: string) {
      this.sent.push(data);
      const frames = framesBySend[this.sendCount++] ?? [];
      for (const frame of frames) {
        this.dispatch("message", { data: JSON.stringify(frame) });
      }
    }

    close() {
      this.readyState = FakeWebSocket.CLOSED;
      this.dispatch("close", { wasClean: true, code: 1000, reason: "" });
    }

    private dispatch(type: string, ev: unknown) {
      this.listeners.get(type)?.forEach((listener) => listener(ev));
    }
  };
}

function makeDocsControllerMock(initialState: Partial<DocsState> = {}): {
  controller: DocsController;
  setState: (partial: Partial<DocsState>) => void;
} {
  const defaultState: DocsState = {
    files: ["README.md"],
    selectedFile: "README.md",
    content: "# Demo docs",
    loading: false,
    error: null,
    ...initialState,
  };

  let currentState = { ...defaultState };
  const listeners = new Set<(state: DocsState) => void>();

  function notify() {
    const snap = {
      ...currentState,
      files: [...currentState.files],
    };
    for (const l of listeners) l(snap);
  }

  function setState(partial: Partial<DocsState>) {
    currentState = { ...currentState, ...partial };
    notify();
  }

  const controller = {
    subscribe: vi.fn((listener: (state: DocsState) => void) => {
      listeners.add(listener);
      listener({
        ...currentState,
        files: [...currentState.files],
      });
      return () => listeners.delete(listener);
    }),
    getState: vi.fn(() => ({
      ...currentState,
      files: [...currentState.files],
    })),
    loadFileList: vi.fn(async () => {}),
    selectFile: vi.fn(async (_filename: string) => {}),
  } as unknown as DocsController;

  return { controller, setState };
}

function makeChatControllerMock(
  initialState: Partial<WsChatControllerState> = {},
): {
  controller: WsChatController;
  setState: (partial: Partial<WsChatControllerState>) => void;
} {
  const assistantOutput = loadClaudeOutput("dev-loop-first-turn");
  const defaultState: WsChatControllerState = {
    messages: [
      { id: "1", role: "user", content: "Refine the button spacing" },
      {
        id: "2",
        role: "assistant",
        content: assistantOutput,
        streaming: false,
      },
    ],
    turnState: "idle",
    connState: "open",
    reconnectAttempt: 0,
    lastError: null,
    ...initialState,
  };

  let currentState = { ...defaultState };
  const listeners = new Set<(state: WsChatControllerState) => void>();

  function notify() {
    const snap = {
      ...currentState,
      messages: [...currentState.messages],
    };
    for (const l of listeners) l(snap);
  }

  function setState(partial: Partial<WsChatControllerState>) {
    currentState = { ...currentState, ...partial };
    notify();
  }

  const controller = {
    subscribe: vi.fn((listener: (state: WsChatControllerState) => void) => {
      listeners.add(listener);
      listener({
        ...currentState,
        messages: [...currentState.messages],
      });
      return () => listeners.delete(listener);
    }),
    getState: vi.fn(() => ({
      ...currentState,
      messages: [...currentState.messages],
    })),
    connect: vi.fn(() => {}),
    disconnect: vi.fn(() => {}),
    sendMessage: vi.fn(async (_text: string) => {}),
  } as unknown as WsChatController;

  return { controller, setState };
}

test("renders docs and seeded assistant output from a Claude fixture", async () => {
  const { controller: docsController } = makeDocsControllerMock({
    files: ["README.md", "design.md"],
    selectedFile: "README.md",
    content: "# README\n\nThis is a demo.",
  });
  const { controller: chatController } = makeChatControllerMock();

  const screen = render(
    <ProductTab
      docsController={docsController}
      chatController={chatController}
    />,
  );

  await expect.element(screen.getByTestId("product-tab")).toBeVisible();
  await expect.element(screen.getByTestId("docs-viewer")).toBeVisible();
  await expect.element(screen.getByTestId("product-chat-panel")).toBeVisible();
  await expect
    .element(screen.getByText("Refine the button spacing"))
    .toBeVisible();
  await expect
    .element(
      screen.getByText(
        /wrote outermost failing test against narrow blueprint context/,
      ),
    )
    .toBeVisible();
});

test("product chat submit calls sendMessage on the injected controller", async () => {
  const { controller: docsController } = makeDocsControllerMock();
  const { controller: chatController } = makeChatControllerMock({
    messages: [],
    turnState: "idle",
  });

  const screen = render(
    <ProductTab
      docsController={docsController}
      chatController={chatController}
    />,
  );

  await screen.getByTestId("product-chat-input").fill("How does steer work?");
  await screen.getByTestId("product-chat-submit").click();

  expect(chatController.sendMessage).toHaveBeenCalledWith(
    "How does steer work?",
  );
});

test("product chat supports a browser multi-turn conversation without crypto.randomUUID", async () => {
  let call = 0;
  vi.stubGlobal("crypto", {
    getRandomValues: (array: Uint8Array) => {
      array.fill(5 + call++);
      return array;
    },
  } as unknown as Crypto);
  vi.stubGlobal(
    "WebSocket",
    makeFakeWebSocket([
      [{ type: "chunk", text: " first browser turn" }, { type: "done" }],
      [{ type: "chunk", text: " second browser turn" }, { type: "done" }],
    ]) as unknown as typeof WebSocket,
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/studio/docs")) {
        return new Response(JSON.stringify({ files: ["README.md"] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/studio/docs/README.md")) {
        return new Response("# Demo docs", {
          status: 200,
          headers: { "Content-Type": "text/markdown" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );

  const screen = render(<ProductTab />);

  await expect.element(screen.getByTestId("product-tab")).toBeVisible();
  await screen.getByTestId("product-chat-input").fill("Tell me more");
  await screen.getByTestId("product-chat-submit").click();
  await expect
    .element(screen.getByText("Tell me more first browser turn"))
    .toBeVisible();

  await screen.getByTestId("product-chat-input").fill("And again");
  await screen.getByTestId("product-chat-submit").click();

  await expect
    .element(screen.getByText("And again second browser turn"))
    .toBeVisible();
});

test("product chat can retry after an assistant error response", async () => {
  vi.stubGlobal(
    "WebSocket",
    makeFakeWebSocket([
      [{ type: "error", message: "claude exited with code 1" }],
      [{ type: "chunk", text: " retry succeeded" }, { type: "done" }],
    ]) as unknown as typeof WebSocket,
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/studio/docs")) {
        return new Response(JSON.stringify({ files: ["README.md"] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/studio/docs/README.md")) {
        return new Response("# Demo docs", {
          status: 200,
          headers: { "Content-Type": "text/markdown" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );

  const screen = render(<ProductTab />);

  await screen.getByTestId("product-chat-input").fill("Why did it fail?");
  await screen.getByTestId("product-chat-submit").click();
  await expect
    .element(screen.getByText(/Error: claude exited with code 1/))
    .toBeVisible();

  await expect.element(screen.getByTestId("product-chat-input")).toBeEnabled();
  await screen.getByTestId("product-chat-input").fill("Try again");
  await screen.getByTestId("product-chat-submit").click();
  await expect
    .element(screen.getByText("Try again retry succeeded"))
    .toBeVisible();
});
