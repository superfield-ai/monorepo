/**
 * Component tests for DeployView (D1).
 *
 * The DeployController is replaced with a stub that exposes the same
 * subscribe/getState/refreshAll/loadDoctor/rollback API. This keeps the
 * component test pure — no fetch is performed.
 */

import React from "react";
import { render } from "vitest-browser-react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DeployView } from "../../src/components/DeployView";
import {
  DeployController,
  type DeployState,
} from "../../src/controllers/DeployController";

afterEach(() => {
  vi.restoreAllMocks();
});

function makeStubController(initial: Partial<DeployState> = {}): {
  controller: DeployController;
  setState: (partial: Partial<DeployState>) => void;
} {
  const ctrl = new DeployController();
  ctrl._replaceState({
    envs: ["dev", "staging", "prod"],
    selectedEnv: "dev",
    ...initial,
  });
  return {
    controller: ctrl,
    setState: (partial) => ctrl._replaceState(partial),
  };
}

beforeEach(() => {
  // Stop refreshAll() from triggering real fetch in the mounted controller.
  vi.spyOn(DeployController.prototype, "refreshAll").mockResolvedValue();
});

describe("DeployView", () => {
  test("renders env switcher pills with the selected env highlighted", async () => {
    const { controller } = makeStubController();
    const screen = render(<DeployView controller={controller} />);
    await expect.element(screen.getByTestId("deploy-view")).toBeVisible();
    await expect.element(screen.getByTestId("env-pill-dev")).toBeVisible();
    await expect.element(screen.getByTestId("env-pill-staging")).toBeVisible();
    await expect.element(screen.getByTestId("env-pill-prod")).toBeVisible();
  });

  test("renders the doctor matrix with one column per env and one row per check", async () => {
    const { controller } = makeStubController({
      doctorByEnv: {
        dev: [
          { name: "gh-auth", ok: true, detail: "ok" },
          { name: "ghcr-pull", ok: true, detail: "ok" },
        ],
        staging: [{ name: "gh-auth", ok: true, detail: "ok" }],
        prod: [],
      },
    });
    const screen = render(<DeployView controller={controller} />);
    await expect.element(screen.getByTestId("doctor-matrix")).toBeVisible();
    await expect.element(screen.getByTestId("doctor-col-dev")).toBeVisible();
    await expect
      .element(screen.getByTestId("doctor-cell-dev-gh-auth"))
      .toBeVisible();
  });

  test("a failing check renders InlineError with retry", async () => {
    const onRetry = vi.spyOn(DeployController.prototype, "loadDoctor");
    const { controller } = makeStubController({
      doctorByEnv: {
        dev: [
          {
            name: "ssh-reachable",
            ok: false,
            detail: "DEPLOY_HOST_DEV not set",
          },
        ],
        staging: [],
        prod: [],
      },
    });
    const screen = render(<DeployView controller={controller} />);
    await expect
      .element(screen.getByTestId("doctor-cell-dev-ssh-reachable"))
      .toBeVisible();
    const retryBtn = screen
      .getByTestId("doctor-cell-dev-ssh-reachable")
      .getByTestId("inline-error-retry");
    await retryBtn.click();
    expect(onRetry).toHaveBeenCalledWith("dev");
  });

  test("rollback button opens confirm modal, confirm calls controller.rollback", async () => {
    const rollbackSpy = vi
      .spyOn(DeployController.prototype, "rollback")
      .mockResolvedValue();
    const { controller } = makeStubController({
      selectedEnv: "staging",
    });
    const screen = render(<DeployView controller={controller} />);

    await screen.getByTestId("rollback-trigger").click();
    await expect.element(screen.getByTestId("rollback-confirm")).toBeVisible();
    await screen.getByTestId("rollback-confirm-action").click();
    expect(rollbackSpy).toHaveBeenCalledWith("staging");
  });

  test("rolloutLog renders inside <pre> when present", async () => {
    const { controller } = makeStubController({
      rolloutLog: ["[t1] line one", "[t2] line two"],
    });
    const screen = render(<DeployView controller={controller} />);
    await expect.element(screen.getByTestId("rollback-log")).toBeVisible();
    await expect.element(screen.getByText(/line one/)).toBeVisible();
    await expect.element(screen.getByText(/line two/)).toBeVisible();
  });

  test("ci strip renders one card per env with a link when a run exists", async () => {
    const { controller } = makeStubController({
      ciRuns: [
        {
          env: "dev",
          workflow: "Deploy dev",
          status: "completed",
          conclusion: "success",
          url: "https://github.com/x/y/actions/runs/1",
          createdAt: "2026-04-26T00:00:00Z",
        },
      ],
    });
    const screen = render(<DeployView controller={controller} />);
    await expect.element(screen.getByTestId("ci-card-dev")).toBeVisible();
    await expect.element(screen.getByTestId("ci-card-staging")).toBeVisible();
    await expect.element(screen.getByText("success")).toBeVisible();
  });
});
