import { describe, it, expect } from "vitest";
import { handleDemoRequest } from "../../src/demo";

function makeReq(method: string, pathname: string): Request {
  return new Request(`http://localhost${pathname}`, { method });
}
function makeUrl(pathname: string): URL {
  return new URL(`http://localhost${pathname}`);
}

describe("handleDemoRequest", () => {
  it("returns null for non-matching path", () => {
    const res = handleDemoRequest(
      makeReq("GET", "/studio/other"),
      makeUrl("/studio/other"),
    );
    expect(res).toBeNull();
  });

  it("returns null for non-GET methods", () => {
    const res = handleDemoRequest(
      makeReq("POST", "/studio/demo/routes"),
      makeUrl("/studio/demo/routes"),
    );
    expect(res).toBeNull();
  });

  it("GET /studio/demo/routes returns an envelope with routes", async () => {
    const res = handleDemoRequest(
      makeReq("GET", "/studio/demo/routes"),
      makeUrl("/studio/demo/routes"),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { routes: unknown[] };
    expect(Array.isArray(body.routes)).toBe(true);
  });

  it("GET /studio/demo/mocks returns an envelope with mocks", async () => {
    const res = handleDemoRequest(
      makeReq("GET", "/studio/demo/mocks"),
      makeUrl("/studio/demo/mocks"),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { mocks: unknown[] };
    expect(Array.isArray(body.mocks)).toBe(true);
  });

  it("GET /studio/demo/issues returns an envelope with issues", async () => {
    const res = handleDemoRequest(
      makeReq("GET", "/studio/demo/issues"),
      makeUrl("/studio/demo/issues"),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { issues: unknown[] };
    expect(Array.isArray(body.issues)).toBe(true);
  });
});
