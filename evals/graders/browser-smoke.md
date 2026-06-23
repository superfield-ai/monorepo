# Grader: browser-smoke

> Reusable check that drives the **browser**. Today: confirms the user-facing
> surface reflects the loop's output. Tomorrow: drives the generated app itself.

## Today (render-only)

The loop does not deploy a runnable app, and Studio's preview iframe shows the
**platform's own** app, not a generated one. So this grader only confirms Studio
loads and renders the loop's output:

- load `STUDIO_URL` (default `http://localhost:7000/studio/`),
- assert the page shows a **plan** and an **issue/feature rail**,
- save a full-page screenshot for eyeballing.

This is **observed, not gating** — see [`todo-app/acceptance.md`](../scenarios/todo-app/acceptance.md).

## When deploy lands (behavioral)

Once a generated app is reachable, this grader is promoted to the true
acceptance check — drive the app, not the dashboard:

- add a task → assert it appears in the list,
- complete a task → assert it renders as done.

At that point `todo-app` adds a gating `rung3` backed by this grader.

## Implementation note

Browser driving is Playwright/Chromium — the one place evals reach outside the
CLI + DB. Keep it thin: a scenario supplies the URL and the assertions; the
grader supplies the harness.
