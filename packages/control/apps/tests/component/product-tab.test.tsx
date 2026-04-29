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
import type { DocsController, DocsState } from "../../src/controllers/DocsController";
import type {
  WsChatController,
  WsChatControllerState,
} from "../../src/controllers/ChatController";
import { loadClaudeOutput } from "../helpers/claude-fixtures";

afterEach(() => {
  vi.restoreAllMocks();
});

function makeDocsControllerMock(
  initialState: Partial<DocsState> = {},
): {
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
    <ProductTab docsController={docsController} chatController={chatController} />,
  );

  await expect.element(screen.getByTestId("product-tab")).toBeVisible();
  await expect.element(screen.getByTestId("docs-viewer")).toBeVisible();
  await expect.element(screen.getByTestId("product-chat-panel")).toBeVisible();
  await expect.element(screen.getByText("Refine the button spacing")).toBeVisible();
  await expect
    .element(screen.getByText(/wrote outermost failing test against narrow blueprint context/))
    .toBeVisible();
});

test("product chat submit calls sendMessage on the injected controller", async () => {
  const { controller: docsController } = makeDocsControllerMock();
  const { controller: chatController } = makeChatControllerMock({
    messages: [],
    turnState: "idle",
  });

  const screen = render(
    <ProductTab docsController={docsController} chatController={chatController} />,
  );

  await screen.getByTestId("product-chat-input").fill("How does steer work?");
  await screen.getByTestId("product-chat-submit").click();

  expect(chatController.sendMessage).toHaveBeenCalledWith(
    "How does steer work?",
  );
});
