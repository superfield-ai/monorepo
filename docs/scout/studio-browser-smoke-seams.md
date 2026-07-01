# Dev-Scout Findings: the Studio browser-smoke seams for the todo-app eval

**Issue:** #829 (scout) — pins the five open questions blocking #815
**Phase:** eval-browser-smoke
**Scout date:** 2026-07-01
**Canonical docs:** `docs/adr-ci-execution-manifest.md`; `evals/README.md`; `evals/graders/browser-smoke.md`
**Downstream issues:**

| Issue | Feature                                                               | What this scout pins for it                                                                                        |
| ----- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| #815  | Capture the Studio browser-smoke screenshot work product for todo-app | The Studio URL/port, the headless driver + its ci-runner availability, the `browser_smoke` flip, and the out path. |

This is a **stub-only / documentation** pass. It changes **no** runtime
behaviour: no browser-smoke step is added to `eval-todo-app.yml`, no screenshot
is produced, and `browser_smoke` still reports `skipped`. Building the producer
step is the downstream feature's (#815) job. Everything below is the executable
target that step must hit.

> **Loud-skip invariant.** The current `skipped` verdict is not itself a
> silent-skip violation — the browser leg is **observed, not gating** (see
> `evals/scenarios/todo-app/acceptance.md` and `crates/sf-eval/src/result.rs`).
> But #815 must not merely flip `skipped → pass` on a doc/lint surface: the flip
> has to be produced by a step that actually drove the HTTP surface and wrote a
> non-empty screenshot in CI (§3, §6). A `pass` with no executed capture is a
> false green.

---

## 1. Studio URL — the port and surface the appliance serves during the eval

**Resolved:** the appliance binds **`0.0.0.0:7000`** and the browser-smoke
target is **`http://127.0.0.1:7000/`**.

- The default bind is `0.0.0.0:7000`, set in `crates/superfield/src/main.rs:230`
  (`let mut bind_addr = "0.0.0.0:7000".parse()...`). The workflow's
  `Boot the appliance` step runs `superfield serve` with **no `--bind`**, so the
  default holds. This matches `sf_serve::ServeConfig::default` (`crates/sf-serve/src/lib.rs:98`).
- **Which surface renders.** The route table (`crates/sf-serve/src/lib.rs:113-121`)
  gives two candidate surfaces:
  - `GET /` — the **unauthenticated** static-asset fallback. With no built UI it
    returns the placeholder page `placeholder_handler`
    (`crates/sf-serve/src/lib.rs:225`): `<title>Superfield Studio</title> … Studio
server is running. Build the web app to serve the full UI.`
  - `/studio/*` — the control-panel API, **auth-required**
    (`crates/sf-serve/src/lib.rs:118`, wrapped by `auth_middleware`). Without a
    session token it returns `401`.
- **The eval serves the placeholder, not the SPA.** `assets_dir` comes only from
  the `CONTROL_ASSETS_DIR` env var (`crates/superfield/src/main.rs:295`). The
  `eval-todo-app.yml` job sets **no** `CONTROL_ASSETS_DIR` and builds **no** web
  app, so `assets_dir = None` and `GET /` serves the placeholder HTML.
- **Consequence for the grader default.** `evals/graders/browser-smoke.md:12`
  documents `STUDIO_URL` default `http://localhost:7000/studio/`. That path is
  **auth-gated and will 401** in the eval as configured. The reachable
  unauthenticated render surface during the eval is **`GET /`** (the placeholder),
  not `/studio/`. #815 must either target `GET /` or add auth + a built UI (see
  §7 remaining question).
- **Reachability before the observer deadline.** The `Boot the appliance` step
  already health-gates the surface: a 60×10s loop curls `/healthz` **or** `/`
  (`.github/workflows/eval-todo-app.yml`, boot step) and only proceeds once one
  answers. (Note: the liveness route is actually `GET /health`, not `/healthz`;
  the `|| curl /` fallback is what actually satisfies the gate via the
  placeholder.) So by the time Seed and the sf-eval observer run, `:7000` is
  already up — comfortably inside `SF_EVAL_DEADLINE_SECS` (1200s) and the 75-min
  job wall.

## 2. Headless driver — what the ci-runner container has, and the minimal change

**Resolved:** the `ghcr.io/superfield-ai/ci-runner:latest` image ships **only
`python3` + `curl`** — **no node, no Playwright, no chromium, no jq**. The
minimal change is to **install `chromium` at step time via `apt-get`** (the same
pattern the workflow already uses for the C toolchain) and drive its **built-in
headless screenshot CLI** — no node, so #810 is sidestepped entirely.

- **What the image lacks (evidence).** Per issue #810 (closed) the image
  deliberately omits `node` (GitHub's runner agent mounts it; the eval workflow
  never needs it). The workflow itself proves the image is minimal: it
  `apt-get install`s `gcc libc6-dev pkg-config libssl-dev` because "the ci-runner
  image ships python3 + curl but no C compiler", and the verify step notes "The
  CI image ships python3 and curl but NOT jq". No chromium/Playwright is present.
- **Do NOT add node/Playwright to the image.** The image build is an external
  repo and out of scope (issue #829 Scope; #810 Fix). `ci-control.yml` /
  `ci-control-template.yml` use `bun x playwright install chromium`, but those
  jobs run on a node-bearing surface; the eval job has no node and must not gain
  one.
- **Chosen headless driver: chromium's own `--headless --screenshot` CLI.**
  Install at step time:
  `apt-get update -y && apt-get install -y --no-install-recommends chromium`
  (Debian) — mirrors the existing gcc install step. Then capture:

  ```bash
  chromium --headless=new --no-sandbox --disable-gpu \
    --window-size=1280,800 \
    --screenshot="$SHOT" \
    "http://127.0.0.1:7000/"
  ```

  `--no-sandbox` is required inside the unprivileged container. This needs **no
  node and no Playwright**, so it does not reopen the #810 node-injection
  problem. (On the Debian base the binary may be `chromium` or `chromium-browser`;
  #815 should probe both. A pure-Rust alternative — the `headless_chrome` crate —
  still requires a chromium binary on the box, so the apt install is the smallest
  common denominator either way.)

- **Loud-fail discipline:** the install + capture must fail the step loudly if
  chromium is absent or the PNG is empty — never skip. If apt cannot reach a
  chromium package on the runner, that is a real gap #815 surfaces (image change
  request), not a silent skip.

## 3. browser_smoke flip — how result.json goes from "skipped" to an executed verdict

**Resolved:** the observer reads the verdict from the **`SF_EVAL_BROWSER_SMOKE`
env var** (default `"skipped"`); flipping it is purely a matter of exporting
`SF_EVAL_BROWSER_SMOKE=pass` (or `fail`) into the sf-eval step's environment. No
sf-eval code change is needed.

- `crates/sf-eval/src/main.rs:333`:
  `let browser_smoke = std::env::var("SF_EVAL_BROWSER_SMOKE").unwrap_or_else(|_| "skipped".into());`
  The comment there is explicit: "The browser smoke is driven **outside this
  binary**; record it as skipped here unless a verdict was supplied via the
  environment."
- The value is threaded through `flush_result(...)` → `evaluate_run(...)` →
  `RunResult.browser_smoke` (`crates/sf-eval/src/result.rs:97`), which is
  serialized into `result.json`. The observer reads the env **once at start** and
  stamps the same verdict into **every** flush (the up-front deterministic-floor
  flush and each poll), so the value is durable even if the process is later
  wall-killed.
- **Therefore the flip mechanism is:** the browser-smoke producer step decides
  `pass`/`fail` from the capture outcome and writes
  `echo "SF_EVAL_BROWSER_SMOKE=pass" >> "$GITHUB_ENV"`. Because `$GITHUB_ENV`
  propagates to **subsequent** steps, the producer step must run **before** the
  `Run the todo-app scenario` step (§5). The existing test
  `crates/sf-eval/tests/live_runner.rs:51,86` already asserts a supplied `"pass"`
  round-trips into `result.json`, so the observer contract is proven; #815 need
  only supply the env var.

## 4. screenshot path — the exact tree the existing upload retains

**Resolved:** write the screenshot to
**`evals/results/todo-app/00000000-0000-4000-8000-000000000748/studio-smoke.png`**
(i.e. `evals/results/<scenario>/<workspace-id>/studio-smoke.png`). This is under
the `evals/results/todo-app/**` upload prefix that already retains artifacts for
30 days.

- The per-run artifact directory is `run_dir` in `crates/sf-eval/src/main.rs`:
  `results_root.join(scenario).join(workspace_id.to_string())`, with
  `results_root = evals/results` (default), `scenario = todo-app`. This is the
  same dir `result.json`, `project-graph.md`, `candidate-*.json`, and `turns.json`
  land in.
- **Workspace-id wiring — there is NO `SF_EVAL_WORKSPACE_ID`.** sf-eval resolves
  the workspace id from the **`WORKSPACE_ID`** env var **or** the
  `--workspace-id` flag (`crates/sf-eval/src/main.rs:77,102`). The workflow sets
  `WORKSPACE_ID: 00000000-0000-4000-8000-000000000748` and passes
  `--workspace-id "${WORKSPACE_ID}"` to both `garden` and `sf-eval run`. So the
  concrete run dir is
  `evals/results/todo-app/00000000-0000-4000-8000-000000000748/`.
  (The scout brief's `SF_EVAL_WORKSPACE_ID` name does not exist in the code — the
  live env var is `WORKSPACE_ID`; #815 must use that.)
- **The producer must `mkdir -p` this dir itself.** Because the browser-smoke
  step runs **before** the sf-eval step (§5), `run_dir` may not yet exist when the
  screenshot is written; the step must
  `mkdir -p "evals/results/todo-app/${WORKSPACE_ID}"` first (mirroring the
  existing `Prepare the eval results + log directory` step that pre-creates
  `_logs/`).
- **Retention is already wired (do not touch).** The `Upload the eval results
tree` step uploads `path: evals/results/todo-app/**` with `if: always()` and
  `retention-days: 30`. A PNG under that prefix uploads with **no further
  change** — confirmed by the step's own comment and
  `evals/scenarios/todo-app/README.md:49`. Landed in #814/PR #809; out of scope
  here.

## 5. workflow slot — where the step goes without racing the observer deadline flush

**Resolved:** insert one new step, **`Studio browser-smoke (capture + verdict)`**,
**after `Boot the appliance` and before `Run the todo-app scenario`** in the
`eval-todo-app` job. There is no race with the observer's deadline flush.

- Ordering rationale:
  1. It must run **after** `Boot the appliance` so `:7000` is reachable (§1).
  2. It does **not** need Seed, but placing it after Seed is also fine; the
     simplest slot is immediately before `Run the todo-app scenario`.
  3. It must run **before** `Run the todo-app scenario` so the
     `SF_EVAL_BROWSER_SMOKE` it exports to `$GITHUB_ENV` is visible to the sf-eval
     process (§3) and is stamped into the very first (deterministic-floor) flush.
- **No deadline-flush race.** The observer flushes **`result.json`** repeatedly
  until `SF_EVAL_DEADLINE_SECS`; the browser-smoke step writes a **separate file**
  (`studio-smoke.png`) and finishes **before** the observer starts, so there is no
  concurrent writer to `result.json` and no file contention with the deadline
  flush. The verdict is a fixed env value read once at observer start — it cannot
  be clobbered mid-run.
- The `Stop the appliance` (`if: always()`) and `Upload` steps are untouched; the
  screenshot is already on disk under the upload prefix by the time either runs.
- **Parseability:** the added step is an ordinary `run:` block; the YAML stays
  valid. (Test-plan check: a workflow parse of `eval-todo-app.yml` still
  succeeds.)

## 6. What "executed, not skipped" must mean for #815 (coverage honesty)

A `pass` is only honest if the step **actually drove `:7000` and wrote a
non-empty screenshot in CI**. Concretely #815's step should:

- assert `chromium` (or `chromium-browser`) is present, else fail loudly;
- assert `http://127.0.0.1:7000/` answers `200` (curl) before capture;
- run the headless `--screenshot` capture into the §4 path;
- assert the PNG exists and is non-empty (`test -s "$SHOT"`), else `fail`;
- export `SF_EVAL_BROWSER_SMOKE=pass` only on all of the above, else `fail`.

That gives an **executed** verdict backed by an uploaded artifact — not a
doc/lint green.

## 7. Remaining open question for #815 (the one decision the scout does not make)

**`render_assertion_depth`** — how deep the "render" assertion goes. Because the
eval serves the **placeholder** at `GET /` (assets unset, §1) and `/studio/` is
**auth-gated** (401), the grader's documented "assert the page shows a plan and
an issue/feature rail" (`evals/graders/browser-smoke.md:13`) **cannot pass** as
the job is configured today. #815 must choose one:

- **(A) Reachability smoke of `GET /` (recommended for the first cut).** Capture
  the placeholder, assert `200` + non-empty PNG. Executed and honest, but shallow
  (it does not assert loop output is rendered). Matches "observed, not gating".
- **(B) Real render assertion.** Build the control web app, set
  `CONTROL_ASSETS_DIR`, mint a session token, and target `/studio/` — a larger
  change that pulls the web toolchain into this job. Out of proportion for an
  observed leg today; better deferred to when deploy/preview lands (the grader's
  "When deploy lands" section).

This is a **product/scope decision** for #815, not a blocking unknown for
parallelism — #815 is the sole non-scout feature in this phase, so there is no
same-phase conflict to gate.

---

## Summary of pinned seams

| Question           | Resolution                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Studio URL / port  | `http://127.0.0.1:7000/` (bind `0.0.0.0:7000`); `GET /` placeholder is the unauth surface; `/studio/` is 401.                |
| headless driver    | Image has python3+curl only; install `chromium` via apt at step time, drive `chromium --headless --screenshot`; no node.     |
| browser_smoke flip | Export `SF_EVAL_BROWSER_SMOKE=pass\|fail` to `$GITHUB_ENV` before the sf-eval step; observer stamps it into result.json.     |
| screenshot path    | `evals/results/todo-app/00000000-0000-4000-8000-000000000748/studio-smoke.png` (`WORKSPACE_ID`, not `SF_EVAL_WORKSPACE_ID`). |
| workflow slot      | New step after `Boot the appliance`, before `Run the todo-app scenario`; separate file → no deadline-flush race.             |
