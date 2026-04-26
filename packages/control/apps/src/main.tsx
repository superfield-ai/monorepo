/**
 * @file main.tsx
 *
 * Browser entry point for the Superfield Studio UI.
 *
 * Bootstraps the error-handling foundation (DebugStore, console interception,
 * window.onerror / unhandledrejection, backend SSE) BEFORE React mounts, then
 * renders the app inside a top-level ErrorBoundary so any render-time crash
 * surfaces a labelled card with Retry + Open-debug-view rather than a blank
 * white screen.
 */

import React from "react";
import { createRoot } from "react-dom/client";
import { ControlPanel } from "./components";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { bootstrapErrorHandling } from "./lib/bootstrap";

bootstrapErrorHandling({ isDev: Boolean(import.meta.env.DEV) });

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Missing #root element");

createRoot(rootEl).render(
  <ErrorBoundary label="Studio">
    <ControlPanel />
  </ErrorBoundary>,
);
