import { describe, expect, test } from "bun:test";
import type { ApiMethod } from "../src/api/router.ts";
import { createApiRoutes } from "../src/api/routes/index.ts";
import { createHarness, response } from "./helpers/server-harness.ts";

const EXPECTED_ROUTES = [
  ["GET", "/api"],
  ["GET", "/api/devices"],
  ["GET", "/api/device-grid"],
  ["POST", "/api/devices/select"],
  ["POST", "/api/avds/start"],
  ["POST", "/api/avds/stop"],
  ["GET", "/api/orientation"],
  ["POST", "/api/orientation"],
  ["GET", "/api/night-mode"],
  ["POST", "/api/night-mode"],
  ["GET", "/api/font-scale"],
  ["POST", "/api/font-scale"],
  ["GET", "/api/network"],
  ["POST", "/api/network"],
  ["GET", "/api/logcat"],
  ["GET", "/api/screenshot"],
  ["POST", "/api/screenshot"],
  ["GET", "/api/foreground"],
  ["GET", "/api/accessibility"],
  ["POST", "/api/accessibility/tap"],
  ["POST", "/api/tap"],
  ["POST", "/api/swipe"],
  ["POST", "/api/text"],
  ["POST", "/api/key"],
  ["POST", "/api/apps/install"],
  ["POST", "/api/files/import"],
  ["POST", "/api/apps/launch"],
  ["POST", "/api/apps/clear"],
  ["POST", "/api/apps/force-stop"],
  ["POST", "/api/apps/grant"],
  ["GET", "/api/location"],
  ["POST", "/api/location"],
  ["GET", "/api/route"],
  ["POST", "/api/route"],
  ["DELETE", "/api/route"],
  ["POST", "/api/route/control"],
  ["GET", "/api/session"],
  ["GET", "/api/session/export"],
  ["DELETE", "/api/session"],
  ["POST", "/api/session/replay"],
  ["POST", "/api/session/replay/stop"],
] as const satisfies readonly (readonly [ApiMethod, string])[];

describe("production API routing", () => {
  test("registers every production route including paginated session export", () => {
    const actual = createApiRoutes()
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    expect(actual).toEqual(
      EXPECTED_ROUTES.map(([method, path]) => `${method} ${path}`).sort(),
    );
    expect(new Set(actual).size).toBe(actual.length);
  });

  test("auth and origin gates precede every registered mutation", async () => {
    const h = await createHarness({ token: "route-secret" });
    for (const [method, path] of EXPECTED_ROUTES) {
      const denied = await response(h.request(path, { method }));
      expect(denied.status, `${method} ${path}`).toBe(401);
      if (method !== "GET") {
        const forbidden = await response(
          h.request(path, {
            method,
            headers: {
              authorization: "Bearer route-secret",
              origin: "https://other.example",
            },
          }),
        );
        expect(forbidden.status, path).toBe(403);
      }
    }
  });

  test("all paths return structured 405s with exact allowed methods", async () => {
    const h = await createHarness();
    const paths = new Set(EXPECTED_ROUTES.map(([, path]) => path));
    for (const path of paths) {
      const res = await response(h.request(path, { method: "PATCH" }));
      const methods = EXPECTED_ROUTES.filter(([, p]) => p === path).map(
        ([m]) => m,
      );
      expect(res.status, path).toBe(405);
      expect(res.headers.get("allow"), path).toBe(methods.join(", "));
      expect(await res.json()).toMatchObject({
        ok: false,
        error: { code: "method_not_allowed" },
      });
    }
  });

  test("validates production JSON routes before performing device work", async () => {
    const h = await createHarness();
    const invalid = {
      "/api/devices/select": {},
      "/api/avds/start": {},
      "/api/avds/stop": {},
      "/api/orientation": { orientation: "sideways" },
      "/api/night-mode": { mode: "blue" },
      "/api/font-scale": { scale: 4 },
      "/api/network": { enabled: "yes" },
      "/api/tap": { x: 2, y: 0 },
      "/api/swipe": { x1: -1 },
      "/api/text": { text: 12 },
      "/api/key": { keycode: -1 },
      "/api/location": { latitude: 100 },
      "/api/route": { points: [] },
      "/api/route/control": { action: "invalid" },
      "/api/session/replay": { multiplier: "2" },
    };
    for (const [path, body] of Object.entries(invalid)) {
      const res = await response(
        h.request(path, { method: "POST", body: JSON.stringify(body) }),
      );
      expect(res.status, path).toBe(400);
      expect(await res.json(), path).toMatchObject({ ok: false });
    }
  });

  test("keeps JSON limits and malformed-body errors on the production path", async () => {
    const h = await createHarness();
    for (const path of [
      "/api/tap",
      "/api/devices/select",
      "/api/session/replay",
    ]) {
      const large = await response(
        h.request(path, { method: "POST", body: " ".repeat(8193) }),
      );
      expect(large.status, path).toBe(413);
      const malformed = await response(
        h.request(path, { method: "POST", body: "{" }),
      );
      expect(malformed.status, path).toBe(400);
    }
  });

  test("serves recorded events through pagination and export", async () => {
    const h = await createHarness();
    const tap = await response(
      h.request("/api/tap", {
        method: "POST",
        body: JSON.stringify({ x: 0.5, y: 0.5 }),
      }),
    );
    expect(tap.status).toBe(200);
    const page = await response(h.request("/api/session?limit=1"));
    expect(await page.json()).toMatchObject({
      session: { eventCount: 1 },
      events: [{ kind: "gesture" }],
    });
    const exported = await response(h.request("/api/session/export"));
    expect(await exported.json()).toMatchObject({
      session: { eventCount: 1 },
      events: [{ kind: "gesture" }],
    });
  });

  test("returns a structured 404 without falling through to static files", async () => {
    const h = await createHarness();
    const res = await response(h.request("/api/missing"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      ok: false,
      error: { code: "not_found", message: "API route not found" },
    });
  });
});
