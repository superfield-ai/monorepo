import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import type { RequestHandler } from "msw";

export function createMswServer(...handlers: RequestHandler[]) {
  const server = setupServer(...handlers);
  return server;
}

export { http, HttpResponse };
