/**
 * @file IssueRail
 *
 * Side rail for the Studio browser UI that surfaces running developer agents
 * grouped by GitHub issue. The rail behaves like an accordion: each issue can
 * be expanded to show its body and checklist, and selecting an issue informs
 * the chat composer which session is currently steerable.
 */

import React from "react";
import type { SlotInfo } from "../controllers/OrchestratorController";

export interface DemoIssueChecklistItem {
  readonly text: string;
  readonly done: boolean;
}

export interface DemoIssue {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "in_progress" | "merged";
  readonly slot: number;
  readonly sessionId: string;
  readonly turnCount: number;
  readonly body: string;
  readonly checklist: readonly DemoIssueChecklistItem[];
}

interface IssueRailProps {
  issues: readonly DemoIssue[];
  slots: readonly SlotInfo[];
  selectedIssueNumber: number | null;
  onSelectIssue: (issue: DemoIssue) => void;
}

function stateLabel(state: DemoIssue["state"]): string {
  switch (state) {
    case "in_progress":
      return "RUNNING";
    case "merged":
      return "MERGED";
    default:
      return "OPEN";
  }
}

export function IssueRail({
  issues,
  slots,
  selectedIssueNumber,
  onSelectIssue,
}: IssueRailProps) {
  const runningIssues =
    slots.length > 0
      ? issues.filter((issue) =>
          slots.some((slot) => slot.issueNumber === issue.number),
        )
      : issues.filter((issue) => issue.state !== "merged");

  return (
    <aside
      data-testid="issue-rail"
      className="flex h-full w-full flex-col border-l border-zinc-700 bg-zinc-950 text-zinc-100"
    >
      <div className="shrink-0 border-b border-zinc-700 px-4 py-3">
        <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-zinc-400">
          Running Agents
        </p>
        <p className="mt-1 text-xs text-zinc-500">
          Select an issue to lock steer mode to that session.
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {runningIssues.length === 0 ? (
          <div className="rounded-lg border border-zinc-700 bg-zinc-900/60 p-4 text-xs text-zinc-400">
            No running developer agents are available.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {runningIssues.map((issue) => {
              const slot = slots.find(
                (candidate) => candidate.issueNumber === issue.number,
              );
              const open = selectedIssueNumber === issue.number;
              return (
                <details
                  key={issue.number}
                  open={open}
                  className="rounded-lg border border-zinc-700 bg-zinc-900/70"
                >
                  <summary
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.preventDefault();
                      onSelectIssue(issue);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelectIssue(issue);
                      }
                    }}
                    className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-left"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm text-zinc-100">
                          #{issue.number}
                        </span>
                        <span className="rounded-full border border-zinc-700 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-400">
                          {stateLabel(issue.state)}
                        </span>
                        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-500">
                          Slot {issue.slot}
                        </span>
                      </div>
                      <p className="mt-1 truncate text-sm text-zinc-200">
                        {issue.title}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] ${
                        open
                          ? "bg-emerald-500/15 text-emerald-300"
                          : "bg-zinc-800 text-zinc-500"
                      }`}
                    >
                      {open ? "Selected" : "Select"}
                    </span>
                  </summary>

                  <div className="border-t border-zinc-800 px-3 py-3 text-sm text-zinc-300">
                    <p className="mb-3 text-xs uppercase tracking-[0.2em] text-zinc-500">
                      Issue Body
                    </p>
                    <p className="whitespace-pre-wrap leading-6 text-zinc-200">
                      {issue.body}
                    </p>
                    <div className="mt-4">
                      <p className="mb-2 text-xs uppercase tracking-[0.2em] text-zinc-500">
                        Checklist
                      </p>
                      <ul className="space-y-2">
                        {issue.checklist.map((item) => (
                          <li
                            key={item.text}
                            className="flex items-start gap-2 text-sm"
                          >
                            <input
                              type="checkbox"
                              checked={item.done}
                              readOnly
                              className="mt-1 h-4 w-4 accent-emerald-500"
                            />
                            <span
                              className={
                                item.done ? "text-zinc-500 line-through" : ""
                              }
                            >
                              {item.text}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div className="mt-4 flex items-center justify-between text-[11px] uppercase tracking-[0.18em] text-zinc-500">
                      <span>{issue.turnCount} turns</span>
                      <span>
                        {slot?.sessionId.slice(0, 10) ??
                          issue.sessionId.slice(0, 10)}
                      </span>
                    </div>
                  </div>
                </details>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}
