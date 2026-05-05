/**
 * Component tests for <WsChat> — Layer 2 composition.
 *
 * Covers:
 *  - Controller lifecycle: connect on mount, disconnect on unmount
 *  - turnState === "streaming" disables the composer
 *  - Submit forwards text to controller.sendMessage and clears the textarea
 *  - turnState === "error" → clearError is called before sendMessage on submit
 *  - Header actions slot is rendered
 *
 * Tests inject a mock WsChatController via the `controller` prop. No real
 * WebSocket connection is opened.
 */

import React from "react";
import { render } from "vitest-browser-react";
import { afterEach, expect, test, vi } from "vitest";
import { WsChat } from "../../src/components/chat/WsChat";
import type {
  WsChatController,
  WsChatControllerState,
} from "../../src/controllers/ChatController";

afterEach(() => {
  vi.restoreAllMocks();
});

function makeWsChatControllerMock(
  initialState: Partial<WsChatControllerState> = {},
): {
  controller: WsChatController;
  setState: (partial: Partial<WsChatControllerState>) => void;
} {
  const defaultState: WsChatControllerState = {
    messages: [],
    turnState: "idle",
    connState: "idle",
    reconnectAttempt: 0,
    ...initialState,
  };

  let currentState = { ...defaultState };
  const listeners = new Set<(state: WsChatControllerState) => void>();

  function snapshot(): WsChatControllerState {
    return { ...currentState, messages: [...currentState.messages] };
  }

  function notify() {
    for (const l of listeners) l(snapshot());
  }

  function setState(partial: Partial<WsChatControllerState>) {
    currentState = { ...currentState, ...partial };
    notify();
  }

  const controller = {
    subscribe: vi.fn((listener: (state: WsChatControllerState) => void) => {
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    }),
    getState: vi.fn(() => snapshot()),
    connect: vi.fn(() => {}),
    disconnect: vi.fn(() => {}),
    sendMessage: vi.fn(async (_text: string) => {}),
    clearError: vi.fn(() => {}),
  } as unknown as WsChatController;

  return { controller, setState };
}

test("calls controller.connect on mount and controller.disconnect on unmount", async () => {
  const { controller } = makeWsChatControllerMock();

  const screen = render(<WsChat controller={controller} />);

  expect(controller.connect).toHaveBeenCalledOnce();
  expect(controller.disconnect).not.toHaveBeenCalled();

  screen.unmount();

  expect(controller.disconnect).toHaveBeenCalledOnce();
});

test("composer is disabled while turnState is 'streaming'", async () => {
  const { controller } = makeWsChatControllerMock({ turnState: "streaming" });

  const screen = render(<WsChat controller={controller} />);

  const textarea = screen.getByTestId("chat-composer-input");
  await expect.element(textarea).toBeDisabled();

  const submit = screen.getByTestId("chat-composer-submit");
  await expect.element(submit).toBeDisabled();
});

test("submit calls controller.sendMessage with typed text and clears input", async () => {
  const { controller } = makeWsChatControllerMock();

  const screen = render(<WsChat controller={controller} />);

  const textarea = screen.getByTestId("chat-composer-input");
  await textarea.fill("hello world");

  const submit = screen.getByTestId("chat-composer-submit");
  await submit.click();

  expect(controller.sendMessage).toHaveBeenCalledWith("hello world");

  // Input is cleared after submit
  const value = (textarea.element() as HTMLTextAreaElement).value;
  expect(value).toBe("");
});

test("when turnState is 'error', submit calls clearError before sendMessage", async () => {
  const { controller } = makeWsChatControllerMock({ turnState: "error" });
  const callOrder: string[] = [];
  (controller.clearError as ReturnType<typeof vi.fn>).mockImplementation(() => {
    callOrder.push("clearError");
  });
  (controller.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
    async () => {
      callOrder.push("sendMessage");
    },
  );

  const screen = render(<WsChat controller={controller} />);

  const textarea = screen.getByTestId("chat-composer-input");
  await textarea.fill("retry me");

  const submit = screen.getByTestId("chat-composer-submit");
  await submit.click();

  expect(controller.clearError).toHaveBeenCalledOnce();
  expect(controller.sendMessage).toHaveBeenCalledWith("retry me");
  expect(callOrder).toEqual(["clearError", "sendMessage"]);
});

test("renders the actions slot in the header", async () => {
  const { controller } = makeWsChatControllerMock();

  const screen = render(
    <WsChat controller={controller} actions={<span>STATUS-BADGE</span>} />,
  );

  await expect.element(screen.getByText("STATUS-BADGE")).toBeVisible();
});
