/**
 * @file main.tsx
 *
 * Browser entry point for the Superfield Studio UI.
 *
 * Bootstraps the error-handling foundation (DebugStore subscriptions,
 * window.onerror / unhandledrejection, backend SSE) BEFORE React mounts,
 * then renders the app inside a top-level ErrorBoundary so any render-time
 * crash surfaces a labelled card with Retry + Open-debug-view rather than a
 * blank white screen. The browser console is untouched — the operating
 * principle is that no error is unhandled at the source, not that the
 * console is silenced.
 */

import React from "react";
import { createRoot } from "react-dom/client";
import { ControlPanel } from "./components";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { bootstrapErrorHandling } from "./lib/bootstrap";
import { debugStore } from "./lib/debug-store";
import "./styles/superfield-tokens.css";
import "./styles/superfield-base.css";

bootstrapErrorHandling({ isDev: Boolean(import.meta.env.DEV) });

// Test seam: expose the DebugStore on globalThis so Playwright specs can
// record entries deterministically without going through the JS console.
// (The webapp does not intercept console.error/warn — see bootstrap.ts.)
(
  globalThis as unknown as { __superfieldDebug: typeof debugStore }
).__superfieldDebug = debugStore;

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Missing #root element");

createRoot(rootEl).render(
  <ErrorBoundary label="Studio">
    <ControlPanel />
  </ErrorBoundary>,
);
