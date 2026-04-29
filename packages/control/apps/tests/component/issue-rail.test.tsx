/**
 * Component tests for IssueRail.
 *
 * Covers the agent-selection rail used to lock steer mode to a live session.
 */

import React from "react";
import { render } from "vitest-browser-react";
import { afterEach, expect, test, vi } from "vitest";
import { IssueRail } from "../../src/components/IssueRail";
import type { SlotInfo } from "../../src/controllers/OrchestratorController";
import type { DemoIssue } from "../../src/components/IssueRail";

afterEach(() => {
  vi.restoreAllMocks();
});

const ISSUES: DemoIssue[] = [
  {
    number: 42,
    title: "Refine the control chat",
    state: "in_progress",
    slot: 1,
    sessionId: "sess-42",
    turnCount: 3,
    body: "Issue body\n\nChecklist",
    checklist: [
      { text: "render assistant output", done: false },
      { text: "keep submit button visible", done: true },
    ],
  },
  {
    number: 7,
    title: "Merged issue",
    state: "merged",
    slot: 2,
    sessionId: "sess-7",
    turnCount: 1,
    body: "Merged body",
    checklist: [],
  },
];

const SLOTS: SlotInfo[] = [
  {
    slot: 1,
    issueNumber: 42,
    role: "primary",
    sessionId: "sess-42",
    backend: "claude",
    model: "claude-sonnet",
    startedAt: new Date().toISOString(),
    elapsedMs: 10_000,
    heartbeatAt: Date.now(),
  },
];

test("renders running issue details and selects the clicked issue", async () => {
  const onSelectIssue = vi.fn();
  const screen = render(
    <IssueRail
      issues={ISSUES}
      slots={SLOTS}
      selectedIssueNumber={42}
      onSelectIssue={onSelectIssue}
    />,
  );

  await expect.element(screen.getByTestId("issue-rail")).toBeVisible();
  await expect.element(screen.getByText("#42")).toBeVisible();
  await expect.element(screen.getByText("Refine the control chat")).toBeVisible();
  await expect.element(screen.getByText("render assistant output")).toBeVisible();
  await expect.element(screen.getByText(/3\s+turns/)).toBeVisible();

  await screen.getByRole("button", { name: /refine the control chat/i }).click();
  expect(onSelectIssue).toHaveBeenCalledWith(ISSUES[0]);
});

test("shows empty state when there are no running issues", async () => {
  const screen = render(
    <IssueRail
      issues={[ISSUES[1]]}
      slots={[]}
      selectedIssueNumber={null}
      onSelectIssue={vi.fn()}
    />,
  );

  await expect
    .element(screen.getByText("No running developer agents are available."))
    .toBeVisible();
});
