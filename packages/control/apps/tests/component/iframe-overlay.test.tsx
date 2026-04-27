/**
 * Component tests for IframeOverlay (E14) and the IframePanel ↔ overlay wiring.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { IframeOverlay } from "../../src/components/IframeOverlay";
import { IframePanel } from "../../src/components/IframePanel";
import { toastStore } from "../../src/lib/toast-store";

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

let originalFetch: typeof globalThis.fetch | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
});

describe("IframeOverlay", () => {
  it("cluster-down mode renders Rebuild + Retry buttons", () => {
    const screen = render(<IframeOverlay mode="cluster-down" />);
    const overlay = screen.container.querySelector(
      '[data-testid="iframe-overlay"]',
    );
    expect(overlay?.getAttribute("data-mode")).toBe("cluster-down");
    expect(
      screen.container.querySelector('[data-testid="iframe-overlay-rebuild"]'),
    ).not.toBeNull();
    expect(
      screen.container.querySelector('[data-testid="iframe-overlay-retry"]'),
    ).not.toBeNull();
  });

  it("build-error mode renders Retry + stderr tail", () => {
    const screen = render(
      <IframeOverlay mode="build-error" buildStderr="error TS2304: foo" />,
    );
    expect(
      screen.container
        .querySelector('[data-testid="iframe-overlay"]')
        ?.getAttribute("data-mode"),
    ).toBe("build-error");
    expect(screen.container.querySelector("pre")?.textContent).toContain(
      "error TS2304: foo",
    );
  });

  it("not-found mode renders 'Back to /' button with the failed path", () => {
    const screen = render(
      <IframeOverlay mode="not-found" failedPath="/missing" />,
    );
    const overlay = screen.container.querySelector(
      '[data-testid="iframe-overlay"]',
    );
    expect(overlay?.getAttribute("data-mode")).toBe("not-found");
    expect(overlay?.textContent).toContain("/missing");
    expect(
      screen.container.querySelector('[data-testid="iframe-overlay-back"]'),
    ).not.toBeNull();
  });

  it("Rebuild button POSTs to the rebuild endpoint", async () => {
    let captured: { url: string; method?: string } | null = null;
    globalThis.fetch = ((url: string, init?: { method?: string }) => {
      captured = { url, method: init?.method };
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as unknown as typeof globalThis.fetch;

    const screen = render(<IframeOverlay mode="cluster-down" />);
    const btn = screen.container.querySelector(
      '[data-testid="iframe-overlay-rebuild"]',
    ) as HTMLButtonElement;
    btn.click();
    await flush();
    await flush();
    expect(captured!.url).toBe("/studio/rebuild");
    expect(captured!.method).toBe("POST");
  });

  it("Rebuild failure surfaces a toast", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            ok: false,
            error: { code: "internal", message: "boom" },
          }),
          {
            status: 500,
            headers: { "content-type": "application/json" },
          },
        ),
      )) as unknown as typeof globalThis.fetch;

    const seen: Array<{ severity: string; title: string }> = [];
    const unsub = toastStore.subscribe((toasts) => {
      for (const t of toasts)
        seen.push({ severity: t.severity, title: t.title });
    });

    const screen = render(<IframeOverlay mode="cluster-down" />);
    const btn = screen.container.querySelector(
      '[data-testid="iframe-overlay-rebuild"]',
    ) as HTMLButtonElement;
    btn.click();
    await flush();
    await flush();
    expect(seen.find((t) => t.severity === "error")?.title).toBe(
      "Rebuild failed",
    );
    unsub();
  });
});

describe("IframePanel + overlay wiring", () => {
  it("renders cluster-down overlay when clusterStatus is degraded", async () => {
    const screen = render(<IframePanel clusterStatus="degraded" />);
    await flush();
    const overlay = screen.container.querySelector(
      '[data-testid="iframe-overlay"]',
    );
    expect(overlay?.getAttribute("data-mode")).toBe("cluster-down");
  });

  it("clears overlay when clusterStatus returns to healthy", async () => {
    const screen = render(<IframePanel clusterStatus="degraded" />);
    await flush();
    expect(
      screen.container.querySelector('[data-testid="iframe-overlay"]'),
    ).not.toBeNull();
    screen.rerender(<IframePanel clusterStatus="healthy" />);
    await flush();
    expect(
      screen.container.querySelector('[data-testid="iframe-overlay"]'),
    ).toBeNull();
  });

  it("failureModeOverride wins (test seam)", async () => {
    const screen = render(
      <IframePanel
        clusterStatus="healthy"
        failureModeOverride="not-found"
        src="/app/missing"
      />,
    );
    await flush();
    const overlay = screen.container.querySelector(
      '[data-testid="iframe-overlay"]',
    );
    expect(overlay?.getAttribute("data-mode")).toBe("not-found");
    expect(overlay?.textContent).toContain("/missing");
  });
});
