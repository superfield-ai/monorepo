/**
 * @file conformance.ts
 *
 * Blueprint conformance feed endpoints (C-9.7).
 *
 * Routes:
 *   GET  /studio/conformance       — { rules: ConformanceRule[] }
 *   POST /studio/conformance       — replace the conformance results (called by agent)
 *
 * The registry is an in-memory singleton. When the agent posts conformance
 * results via POST the UI polls / refreshes and picks up the new data.
 *
 * The comment marker used by `runBlueprintConformance` is:
 *   <!-- superfield-blueprint -->
 *
 * Violation objects in `packages/core/steps/blueprint-conformance.ts` carry
 * rule_id, rule_name, rule_type, domain, concern — we map those to the
 * ConformanceRule shape exposed to the UI.
 */

import { errorResponse } from "../lib/error-envelope";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ConformanceStatus = "pass" | "fail" | "advisory";

export interface ConformanceRule {
  readonly id: string;
  readonly name: string;
  readonly status: ConformanceStatus;
  readonly detail?: string;
}

export interface ConformanceResult {
  readonly rules: ConformanceRule[];
  /** ISO-8601 timestamp of the last update, or null if never updated. */
  readonly updatedAt: string | null;
}

// ── In-memory registry ────────────────────────────────────────────────────────

let _result: ConformanceResult = { rules: [], updatedAt: null };

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Replace the in-memory conformance result with the provided value. */
export function setConformanceResult(result: ConformanceResult): void {
  _result = result;
}

/** Return the current conformance result (for tests and internal use). */
export function getConformanceResult(): ConformanceResult {
  return _result;
}

/** Reset to the initial empty state. Used by tests. */
export function resetConformance(): void {
  _result = { rules: [], updatedAt: null };
}

// ── Request handlers ──────────────────────────────────────────────────────────

function handleGet(): Response {
  return jsonOk(_result);
}

async function handlePost(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse({
      code: "validation",
      message: "Request body must be valid JSON",
      hint: "POST { rules: ConformanceRule[] } to /studio/conformance.",
    });
  }

  if (typeof body !== "object" || body === null) {
    return errorResponse({
      code: "validation",
      message: "Request body must be a JSON object",
      hint: "POST { rules: ConformanceRule[] } to /studio/conformance.",
    });
  }

  const raw = body as Record<string, unknown>;

  if (!Array.isArray(raw.rules)) {
    return errorResponse({
      code: "validation",
      message: "rules field must be an array",
      hint: "POST { rules: ConformanceRule[] } to /studio/conformance.",
    });
  }

  const rules: ConformanceRule[] = [];
  for (const item of raw.rules as unknown[]) {
    if (typeof item !== "object" || item === null) {
      return errorResponse({
        code: "validation",
        message: "Each rule must be an object",
        hint: "Each rule must have { id, name, status } fields.",
      });
    }
    const r = item as Record<string, unknown>;
    if (
      typeof r.id !== "string" ||
      typeof r.name !== "string" ||
      typeof r.status !== "string"
    ) {
      return errorResponse({
        code: "validation",
        message: "Each rule must have string id, name, and status fields",
        hint: "status must be one of: pass, fail, advisory.",
      });
    }
    const status = r.status as string;
    if (status !== "pass" && status !== "fail" && status !== "advisory") {
      return errorResponse({
        code: "validation",
        message: `Invalid status value: ${status}`,
        hint: "status must be one of: pass, fail, advisory.",
      });
    }
    rules.push({
      id: r.id,
      name: r.name,
      status: status as ConformanceStatus,
      detail: typeof r.detail === "string" ? r.detail : undefined,
    });
  }

  _result = { rules, updatedAt: new Date().toISOString() };
  return jsonOk(_result);
}

// ── Public handler ────────────────────────────────────────────────────────────

/**
 * Top-level conformance handler. Returns null for non-matching paths so the
 * router can fall through to other handlers.
 */
export async function handleConformanceRequest(
  req: Request,
  url: URL,
): Promise<Response | null> {
  const { pathname } = url;

  if (pathname !== "/studio/conformance") return null;

  if (req.method === "GET") return handleGet();
  if (req.method === "POST") return handlePost(req);

  return null;
}
