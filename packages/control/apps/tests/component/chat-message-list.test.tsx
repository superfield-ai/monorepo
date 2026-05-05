/**
 * Component tests for ChatMessageList.
 *
 * Covers:
 *  1. Empty messages renders the emptyState slot
 *  2. Two messages render correct data-testid values by role
 *  3. A streaming message renders <span aria-label="streaming">
 *  4. A non-streaming message does NOT render aria-label="streaming"
 *  5. Appending a message triggers bottomRef.current.scrollIntoView
 */

import React, { createRef } from "react";
import { render } from "vitest-browser-react";
import { afterEach, expect, test, vi } from "vitest";
import { ChatMessageList } from "../../src/components/chat/ChatMessageList";
import type { ChatMessage } from "../../src/controllers/ChatController";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("given empty messages, renders the emptyState slot content", async () => {
  const bottomRef = createRef<HTMLDivElement>();
  const screen = render(
    <ChatMessageList
      messages={[]}
      bottomRef={bottomRef}
      emptyState={<p>No messages yet</p>}
    />,
  );

  await expect.element(screen.getByText("No messages yet")).toBeVisible();
});

test("given user and assistant messages, renders rows with correct data-testid", async () => {
  const messages: ChatMessage[] = [
    { id: "1", role: "user", content: "Hello" },
    { id: "2", role: "assistant", content: "Hi there" },
  ];
  const bottomRef = createRef<HTMLDivElement>();
  const screen = render(
    <ChatMessageList messages={messages} bottomRef={bottomRef} />,
  );

  const userRows = screen.getByTestId("message-user").all();
  const assistantRows = screen.getByTestId("message-assistant").all();

  expect(userRows).toHaveLength(1);
  expect(assistantRows).toHaveLength(1);
  await expect.element(screen.getByText("Hello")).toBeVisible();
  await expect.element(screen.getByText("Hi there")).toBeVisible();
});

test("a message with streaming:true renders span aria-label='streaming'", async () => {
  const messages: ChatMessage[] = [
    { id: "1", role: "assistant", content: "Generating...", streaming: true },
  ];
  const bottomRef = createRef<HTMLDivElement>();
  const screen = render(
    <ChatMessageList messages={messages} bottomRef={bottomRef} />,
  );

  await expect
    .element(screen.getByTestId("chat-streaming-indicator"))
    .toBeInTheDocument();
});

test("a message with streaming:false does NOT render aria-label='streaming'", async () => {
  const messages: ChatMessage[] = [
    { id: "1", role: "assistant", content: "Done", streaming: false },
  ];
  const bottomRef = createRef<HTMLDivElement>();
  const screen = render(
    <ChatMessageList messages={messages} bottomRef={bottomRef} />,
  );

  expect(
    document.querySelector('[data-testid="chat-streaming-indicator"]'),
  ).toBeNull();
});

test("when a new message is appended, bottomRef.current.scrollIntoView is called", async () => {
  const messages: ChatMessage[] = [
    { id: "1", role: "user", content: "First message" },
  ];
  const bottomRef = createRef<HTMLDivElement>();

  const { rerender } = render(
    <ChatMessageList messages={messages} bottomRef={bottomRef} />,
  );

  // Spy on scrollIntoView after initial render so the div ref is populated
  const scrollSpy = vi.fn();
  if (bottomRef.current) {
    bottomRef.current.scrollIntoView = scrollSpy;
  }

  const updatedMessages: ChatMessage[] = [
    ...messages,
    { id: "2", role: "assistant", content: "Second message" },
  ];

  await rerender(
    <ChatMessageList messages={updatedMessages} bottomRef={bottomRef} />,
  );

  expect(scrollSpy).toHaveBeenCalledWith({ behavior: "smooth" });
});
