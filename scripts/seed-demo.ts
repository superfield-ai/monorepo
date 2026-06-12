#!/usr/bin/env bun
/**
 * @file scripts/seed-demo.ts (D5 — C-9.8)
 *
 * Seed deterministic demo content for the 2026-04-28 Control Webapp demo. The
 * script populates four artefacts so the four demo screens render with rich
 * data without a running dev loop:
 *
 *   1. <repo>/.studio/demo/routes.json   — per-route preview map (D2 / D3)
 *   2. <repo>/.studio/demo/mocks.json    — fixture-mode mock responses (D5)
 *   3. <repo>/.studio/demo/issues.json   — synthetic agent issue queue (D6)
 *   4. <CONTROL_LOG_DIR>/<today>.jsonl   — JSONL turn-log (D6 timeline source)
 *
 * Usage:
 *   bun run scripts/seed-demo.ts                  # default — writes to repo
 *   CONTROL_LOG_DIR=/tmp/demo-logs bun run scripts/seed-demo.ts
 *
 * The script is idempotent: each invocation overwrites the JSON fixtures and
 * appends a fresh batch of JSONL entries so the timeline always shows recent
 * activity. No system binaries; only Bun's native file APIs.
 *
 * Canonical spec: docs/plan.md §C-9.8 ("scripts/seed-demo.ts").
 */

import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const STUDIO_DIR = join(REPO_ROOT, ".studio", "demo");
const LOG_DIR = process.env.CONTROL_LOG_DIR
  ? resolve(REPO_ROOT, process.env.CONTROL_LOG_DIR)
  : resolve(REPO_ROOT, "..", "studio-logs");

interface DemoRoute {
  readonly path: string;
  readonly title: string;
  readonly description: string;
  readonly mocks: readonly string[];
  readonly viewports: readonly ("mobile" | "tablet" | "desktop")[];
}

const ROUTES: readonly DemoRoute[] = [
  {
    path: "/",
    title: "Landing",
    description: "Marketing hero + product strip.",
    mocks: ["mock:landing.hero.experiment-A"],
    viewports: ["mobile", "tablet", "desktop"],
  },
  {
    path: "/dashboard",
    title: "Customer dashboard",
    description: "Authenticated dashboard with KPI cards.",
    mocks: ["mock:dashboard.kpis.q4-2025", "mock:dashboard.empty"],
    viewports: ["tablet", "desktop"],
  },
  {
    path: "/checkout",
    title: "Checkout",
    description: "Payment flow with discount-code input.",
    mocks: ["mock:checkout.success", "mock:checkout.declined"],
    viewports: ["mobile", "desktop"],
  },
  {
    path: "/settings",
    title: "Settings",
    description: "Profile + notification preferences.",
    mocks: ["mock:settings.default"],
    viewports: ["desktop"],
  },
];

interface DemoMock {
  readonly id: string;
  readonly route: string;
  readonly status: number;
  readonly body: unknown;
}

const MOCKS: readonly DemoMock[] = [
  {
    id: "mock:landing.hero.experiment-A",
    route: "/",
    status: 200,
    body: { hero: "Ship faster with Superfield", cta: "Start free trial" },
  },
  {
    id: "mock:dashboard.kpis.q4-2025",
    route: "/dashboard",
    status: 200,
    body: {
      kpis: [
        { label: "MRR", value: 142000, delta: 0.12 },
        { label: "Active accounts", value: 318, delta: 0.04 },
      ],
    },
  },
  {
    id: "mock:dashboard.empty",
    route: "/dashboard",
    status: 200,
    body: { kpis: [] },
  },
  {
    id: "mock:checkout.success",
    route: "/checkout",
    status: 200,
    body: { id: "ch_demo_1", status: "succeeded" },
  },
  {
    id: "mock:checkout.declined",
    route: "/checkout",
    status: 402,
    body: { error: { code: "card_declined", message: "Card declined." } },
  },
  {
    id: "mock:settings.default",
    route: "/settings",
    status: 200,
    body: { email: "demo@superfield.dev", notifications: { weekly: true } },
  },
];

interface DemoIssue {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "in_progress" | "merged";
  readonly slot: number;
  readonly sessionId: string;
  readonly turnCount: number;
  readonly body: string;
  readonly checklist: readonly { text: string; done: boolean }[];
}

const ISSUE_CHECKOUT: DemoIssue = {
  number: 301,
  title: "Add discount-code input on /checkout",
  state: "in_progress",
  slot: 1,
  sessionId: "0196f4a2b3c1-a3f9d2e4b8c1f0a7",
  turnCount: 4,
  body: "Steer the checkout flow so the user can apply a discount code before payment.",
  checklist: [
    { text: "Add a discount-code input above the Pay button", done: true },
    { text: "Debounce validation by 300 ms", done: true },
    { text: "Surface server rejections as InlineError", done: true },
    { text: "Add Playwright coverage for the happy path", done: false },
  ],
};

const ISSUE_DASHBOARD: DemoIssue = {
  number: 302,
  title: "Tighten KPI card a11y labels on /dashboard",
  state: "in_progress",
  slot: 2,
  sessionId: "0196f4a2b3c2-b1c8e7f3a9d4e2f8",
  turnCount: 2,
  body: "Clean up the dashboard cards so screen readers can announce the key metrics without ambiguity.",
  checklist: [
    { text: "Add explicit aria-labels to KPI cards", done: true },
    { text: "Verify axe-core smoke pass on the dashboard", done: true },
    { text: "Adjust token contrast for the delta text", done: false },
  ],
};

const ISSUE_SETTINGS: DemoIssue = {
  number: 297,
  title: "Refactor settings form to use react-hook-form",
  state: "merged",
  slot: 0,
  sessionId: "0196f49d12a0-c4e7d3a1b2f5e8c1",
  turnCount: 7,
  body: "The settings screen was stabilized and merged; keep it visible as a completed reference for the panel.",
  checklist: [
    { text: "Move settings fields to controlled form state", done: true },
    { text: "Preserve saved notification preferences", done: true },
    { text: "Keep the existing keyboard flow intact", done: true },
  ],
};

const ISSUES: readonly DemoIssue[] = [
  ISSUE_CHECKOUT,
  ISSUE_DASHBOARD,
  ISSUE_SETTINGS,
];

interface TurnLogEntry {
  readonly timestamp: string;
  readonly message: string;
  readonly response: string;
  readonly filesChanged: readonly string[];
  readonly servicesRestarted: readonly string[];
  readonly restartDurationMs: number;
  readonly sessionId: string;
  readonly issueNumber: number;
}

function makeTurns(now: Date): TurnLogEntry[] {
  // Six turns spread across the last 90 minutes for two active sessions.
  const minutesAgo = (m: number) =>
    new Date(now.getTime() - m * 60_000).toISOString();
  return [
    {
      timestamp: minutesAgo(85),
      message: "Add a discount-code input above the Pay button.",
      response: "Added <DiscountCodeInput /> and wired it to checkout state.",
      filesChanged: ["app/checkout/page.tsx", "app/checkout/discount.tsx"],
      servicesRestarted: ["web"],
      restartDurationMs: 4200,
      sessionId: ISSUE_CHECKOUT.sessionId,
      issueNumber: ISSUE_CHECKOUT.number,
    },
    {
      timestamp: minutesAgo(72),
      message: "The input should debounce validation by 300 ms.",
      response: "Added a 300 ms debounce via useDeferredValue.",
      filesChanged: ["app/checkout/discount.tsx"],
      servicesRestarted: ["web"],
      restartDurationMs: 3950,
      sessionId: ISSUE_CHECKOUT.sessionId,
      issueNumber: ISSUE_CHECKOUT.number,
    },
    {
      timestamp: minutesAgo(58),
      message: "Show a red InlineError when the code is rejected.",
      response: "Surfaced server validation errors as InlineError below input.",
      filesChanged: ["app/checkout/discount.tsx"],
      servicesRestarted: ["web"],
      restartDurationMs: 3800,
      sessionId: ISSUE_CHECKOUT.sessionId,
      issueNumber: ISSUE_CHECKOUT.number,
    },
    {
      timestamp: minutesAgo(40),
      message: "Add aria-labels to the KPI cards.",
      response: "Added aria-label and role=group to each KPI card.",
      filesChanged: ["app/dashboard/kpi-card.tsx"],
      servicesRestarted: ["web"],
      restartDurationMs: 4100,
      sessionId: ISSUE_DASHBOARD.sessionId,
      issueNumber: ISSUE_DASHBOARD.number,
    },
    {
      timestamp: minutesAgo(22),
      message: "Run the axe-core smoke pass and fix any contrast issues.",
      response: "Bumped the KPI delta colour from #8a8 to #4d8a4d for AA.",
      filesChanged: ["app/dashboard/kpi-card.tsx", "app/styles/tokens.css"],
      servicesRestarted: ["web"],
      restartDurationMs: 4350,
      sessionId: ISSUE_DASHBOARD.sessionId,
      issueNumber: ISSUE_DASHBOARD.number,
    },
    {
      timestamp: minutesAgo(8),
      message: "Re-run the discount-code input on viewport=mobile.",
      response: "All three viewports render correctly; no overflow at 360 px.",
      filesChanged: [],
      servicesRestarted: [],
      restartDurationMs: 0,
      sessionId: ISSUE_CHECKOUT.sessionId,
      issueNumber: ISSUE_CHECKOUT.number,
    },
  ];
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function main(): void {
  mkdirSync(STUDIO_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });

  writeJson(join(STUDIO_DIR, "routes.json"), { routes: ROUTES });
  writeJson(join(STUDIO_DIR, "mocks.json"), { mocks: MOCKS });
  writeJson(join(STUDIO_DIR, "issues.json"), { issues: ISSUES });

  const now = new Date();
  const turns = makeTurns(now);
  const logPath = join(LOG_DIR, `${now.toISOString().slice(0, 10)}.jsonl`);
  for (const turn of turns) {
    appendFileSync(logPath, JSON.stringify(turn) + "\n", "utf8");
  }

  console.log(
    `Seeded ${ROUTES.length} routes, ${MOCKS.length} mocks, ${ISSUES.length} issues.`,
  );
  console.log(`Demo fixtures: ${STUDIO_DIR}`);
  console.log(`Turn log:      ${logPath} (+${turns.length} entries)`);
}

main();
