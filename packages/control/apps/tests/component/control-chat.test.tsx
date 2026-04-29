/**
 * Component tests for ControlChat — Layer 2.
 *
 * Covers:
 *  - Renders commit list from CommitController state
 *  - Rollback button calls commitController.rollback(sha) with correct sha
 *  - Commit list refreshes after a chat turn completes (fetchStatus called)
 *
 * All tests inject mock ChatController and CommitController instances as props.
 * No real fetch calls are made — the mock objects double the controller interface.
 *
 * Canonical docs: test-plan.md §Layer 2 / ControlChat.
 */

import React from "react";
import { render } from "vitest-browser-react";
import { afterEach, expect, test, vi } from "vitest";
import { ControlChat } from "../../src/components/ControlChat";
import type {
  ChatController,
  ChatControllerState,
} from "../../src/controllers/ChatController";
import type {
  CommitController,
  CommitControllerState,
  Commit,
  TimelineEntry,
} from "../../src/controllers/CommitController";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Mock controller factories
// ---------------------------------------------------------------------------

function makeChatControllerMock(
  initialState: Partial<ChatControllerState> = {},
): {
  controller: ChatController;
  setState: (partial: Partial<ChatControllerState>) => void;
} {
  const defaultState: ChatControllerState = {
    messages: [],
    turnState: "idle",
    ...initialState,
  };

  let currentState = { ...defaultState };
  const listeners = new Set<(state: ChatControllerState) => void>();

  function notify() {
    const snap = { ...currentState, messages: [...currentState.messages] };
    for (const l of listeners) l(snap);
  }

  function setState(partial: Partial<ChatControllerState>) {
    currentState = { ...currentState, ...partial };
    notify();
  }

  const controller = {
    subscribe: vi.fn((listener: (state: ChatControllerState) => void) => {
      listeners.add(listener);
      listener({ ...currentState, messages: [...currentState.messages] });
      return () => listeners.delete(listener);
    }),
    getState: vi.fn(() => ({
      ...currentState,
      messages: [...currentState.messages],
    })),
    sendMessage: vi.fn(async (_text: string) => {}),
    resetSession: vi.fn(async () => {}),
  } as unknown as ChatController;

  return { controller, setState };
}

function makeCommitControllerMock(
  initialState: Partial<CommitControllerState> = {},
): {
  controller: CommitController;
  setState: (partial: Partial<CommitControllerState>) => void;
} {
  const defaultState: CommitControllerState = {
    commits: [],
    timeline: [],
    loading: false,
    error: null,
    ...initialState,
  };

  let currentState = { ...defaultState };
  const listeners = new Set<(state: CommitControllerState) => void>();

  function notify() {
    const snap = {
      ...currentState,
      commits: [...currentState.commits],
      timeline: [...currentState.timeline],
    };
    for (const l of listeners) l(snap);
  }

  function setState(partial: Partial<CommitControllerState>) {
    currentState = { ...currentState, ...partial };
    notify();
  }

  const controller = {
    subscribe: vi.fn((listener: (state: CommitControllerState) => void) => {
      listeners.add(listener);
      listener({
        ...currentState,
        commits: [...currentState.commits],
        timeline: [...currentState.timeline],
      });
      return () => listeners.delete(listener);
    }),
    getState: vi.fn(() => ({
      ...currentState,
      commits: [...currentState.commits],
      timeline: [...currentState.timeline],
    })),
    fetchStatus: vi.fn(async () => ({
      active: true,
      sessionId: "test-session",
      branch: "main",
    })),
    rollback: vi.fn(async (_hash: string): Promise<Commit[] | null> => null),
    setCommits: vi.fn((_commits: Commit[]) => {}),
  } as unknown as CommitController;

  return { controller, setState };
}

// ---------------------------------------------------------------------------
// ControlChat tests
// ---------------------------------------------------------------------------

test("renders commit list from CommitController with two commits", async () => {
  const { controller: chatController } = makeChatControllerMock();
  const { controller: commitController } = makeCommitControllerMock({
    commits: [
      { hash: "abc1234", message: "studio: initial commit" },
      { hash: "def5678", message: "studio: update header" },
    ],
  });

  const screen = render(
    <ControlChat
      chatController={chatController}
      commitController={commitController}
    />,
  );

  await expect
    .element(screen.getByText("studio: initial commit"))
    .toBeVisible();
  await expect.element(screen.getByText("studio: update header")).toBeVisible();
});

test("rollback button calls commitController.rollback(sha) with the correct sha", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);

  const { controller: chatController } = makeChatControllerMock();
  const { controller: commitController } = makeCommitControllerMock({
    commits: [{ hash: "abc1234", message: "studio: update header" }],
  });

  const screen = render(
    <ControlChat
      chatController={chatController}
      commitController={commitController}
    />,
  );

  const rollbackButton = screen.getByRole("button", {
    name: "Rollback commit",
  });
  await expect.element(rollbackButton).toBeVisible();
  await rollbackButton.click();

  expect(commitController.rollback).toHaveBeenCalledWith("abc1234");
});

test("reset session button calls chatController.resetSession", async () => {
  const { controller: chatController } = makeChatControllerMock();
  const { controller: commitController } = makeCommitControllerMock();

  const screen = render(
    <ControlChat
      chatController={chatController}
      commitController={commitController}
    />,
  );

  const resetButton = screen.getByRole("button", { name: "Reset session" });
  await expect.element(resetButton).toBeVisible();
  await resetButton.click();

  expect(chatController.resetSession).toHaveBeenCalledOnce();
});

test("commit list does not roll back when user cancels confirmation", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(false);

  const { controller: chatController } = makeChatControllerMock();
  const { controller: commitController } = makeCommitControllerMock({
    commits: [{ hash: "def5678", message: "studio: change styles" }],
  });

  const screen = render(
    <ControlChat
      chatController={chatController}
      commitController={commitController}
    />,
  );

  const rollbackButton = screen.getByRole("button", {
    name: "Rollback commit",
  });
  await rollbackButton.click();

  expect(commitController.rollback).not.toHaveBeenCalled();
  // Commit still visible
  await expect.element(screen.getByText("studio: change styles")).toBeVisible();
});

test("fetchStatus is called to refresh commit list after chat turn completes", async () => {
  const { controller: chatController, setState: setChatState } =
    makeChatControllerMock({
      turnState: "idle",
    });
  const { controller: commitController } = makeCommitControllerMock();

  render(
    <ControlChat
      chatController={chatController}
      commitController={commitController}
    />,
  );

  // Simulate a chat turn: idle → streaming → idle.
  // Each state change must be awaited so React flushes the render and the
  // useEffect dependency on chatState.turnState fires between the two transitions.
  // Without the microtask flush React 18 batches the two synchronous setState
  // calls and the streaming → idle transition is never observed by the effect.
  setChatState({ turnState: "streaming" });
  await new Promise((r) => setTimeout(r, 0));
  setChatState({ turnState: "idle" });
  await new Promise((r) => setTimeout(r, 0));

  // fetchStatus should have been called: once on mount + once after turn
  expect(commitController.fetchStatus).toHaveBeenCalledTimes(2);
});

// ---------------------------------------------------------------------------
// Timeline view tests
// ---------------------------------------------------------------------------

test("renders timeline-view when timeline array is non-empty", async () => {
  const { controller: chatController } = makeChatControllerMock();
  const timelineEntries: TimelineEntry[] = [
    {
      hash: "abc1234",
      message: "Design: add button",
      timestamp: "2026-03-25T10:00:00.000Z",
    },
  ];
  const { controller: commitController } = makeCommitControllerMock({
    timeline: timelineEntries,
  });

  const screen = render(
    <ControlChat
      chatController={chatController}
      commitController={commitController}
    />,
  );

  await expect.element(screen.getByTestId("timeline-view")).toBeVisible();
});

test("each timeline entry displays correct summary text and a non-empty timestamp", async () => {
  const { controller: chatController } = makeChatControllerMock();
  const timelineEntries: TimelineEntry[] = [
    {
      hash: "abc1234",
      message: "Design: add button",
      timestamp: "2026-03-25T10:00:00.000Z",
    },
    {
      hash: "def5678",
      message: "Design: update header",
      timestamp: "2026-03-25T11:00:00.000Z",
    },
  ];
  const { controller: commitController } = makeCommitControllerMock({
    timeline: timelineEntries,
  });

  const screen = render(
    <ControlChat
      chatController={chatController}
      commitController={commitController}
    />,
  );

  await expect.element(screen.getByText("Design: add button")).toBeVisible();
  await expect.element(screen.getByText("Design: update header")).toBeVisible();

  // Both timestamp elements should be present and non-empty
  const timestamps = screen.getByTestId("timeline-timestamp").all();
  await expect.element(timestamps[0]).toBeVisible();
  await expect.element(timestamps[1]).toBeVisible();

  // Timestamps are non-empty strings derived from the ISO timestamp
  const firstTimestampText = await timestamps[0].element().textContent;
  expect(firstTimestampText).toBeTruthy();
  const secondTimestampText = await timestamps[1].element().textContent;
  expect(secondTimestampText).toBeTruthy();
});

test("clicking rollback button in a timeline entry calls commitController.rollback with entry hash", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);

  const { controller: chatController } = makeChatControllerMock();
  const timelineEntries: TimelineEntry[] = [
    {
      hash: "abc1234",
      message: "Design: add button",
      timestamp: "2026-03-25T10:00:00.000Z",
    },
  ];
  const { controller: commitController } = makeCommitControllerMock({
    timeline: timelineEntries,
  });

  const screen = render(
    <ControlChat
      chatController={chatController}
      commitController={commitController}
    />,
  );

  const rollbackButton = screen.getByRole("button", {
    name: "Rollback commit",
  });
  await expect.element(rollbackButton).toBeVisible();
  await rollbackButton.click();

  expect(commitController.rollback).toHaveBeenCalledWith("abc1234");
});

test("when both timeline and commits are non-empty, timeline entries are rendered", async () => {
  const { controller: chatController } = makeChatControllerMock();
  const timelineEntries: TimelineEntry[] = [
    {
      hash: "abc1234",
      message: "Timeline: checkpoint one",
      timestamp: "2026-03-25T10:00:00.000Z",
    },
  ];
  const commits: Commit[] = [
    { hash: "def5678", message: "Commits: legacy entry" },
  ];
  const { controller: commitController } = makeCommitControllerMock({
    timeline: timelineEntries,
    commits,
  });

  const screen = render(
    <ControlChat
      chatController={chatController}
      commitController={commitController}
    />,
  );

  // Timeline entry should be visible
  await expect
    .element(screen.getByText("Timeline: checkpoint one"))
    .toBeVisible();
  // Commits-only entry should not be rendered when timeline is non-empty
  await expect
    .element(screen.getByText("Commits: legacy entry"))
    .not.toBeInTheDocument();
});
