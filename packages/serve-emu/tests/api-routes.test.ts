import { describe, expect, spyOn, test } from "bun:test";
import type { ApiMethod } from "../src/api/router.ts";
import { createApiRoutes } from "../src/api/routes/index.ts";
import { CommandFailureError } from "../src/command-failure.ts";
import {
  parseApiFailure,
  type ApiErrorCode,
} from "../src/shared/api-contracts.ts";
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

/** The failure's code, after checking the body is a shared ApiFailure. */
async function failureCode(res: Response): Promise<ApiErrorCode> {
  return parseApiFailure(await res.json()).error.code;
}

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
      expect(await failureCode(denied), `${method} ${path}`).toBe("unauthorized");
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
        expect(await failureCode(forbidden), path).toBe("forbidden");
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
      expect(await failureCode(res), path).toBe("method_not_allowed");
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
      expect(await failureCode(res), path).toBe("invalid_request");
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
      expect(await failureCode(large), path).toBe("payload_too_large");
      const malformed = await response(
        h.request(path, { method: "POST", body: "{" }),
      );
      expect(malformed.status, path).toBe(400);
      expect(await failureCode(malformed), path).toBe("invalid_json");
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

  test("reports device command failures without their output", async () => {
    const geoFixOutput = "KO: bad command /home/me/.android/emulator_console_auth_token";
    const h = await createHarness({}, {
      setLocation: async () => {
        throw new CommandFailureError(
          "adb-failed",
          "adb emu geo fix failed",
          geoFixOutput,
        );
      },
    });
    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    try {
      const location = await response(
        h.request("/api/location", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ latitude: 37.5, longitude: 127 }),
        }),
      );
      expect(location.status).toBe(502);
      expect(await location.json()).toEqual({
        ok: false,
        error: {
          code: "downstream_failure",
          message: "adb emu geo fix failed",
          reason: "adb-failed",
        },
      });
      expect(errorLog).toHaveBeenCalledWith(
        "[api] POST /api/location -> 502 adb emu geo fix failed:",
        expect.objectContaining({
          message: `adb emu geo fix failed: ${geoFixOutput}`,
        }),
      );
      errorLog.mockClear();

      const route = await response(
        h.request("/api/route", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            waypoints: [
              { latitude: 37.5, longitude: 127 },
              { latitude: 37.51, longitude: 127.01 },
            ],
          }),
        }),
      );
      expect(route.status).toBe(502);
      const routeBody = await route.text();
      expect(JSON.parse(routeBody)).toEqual({
        ok: false,
        error: {
          code: "downstream_failure",
          message: "adb emu geo fix failed",
          reason: "adb-failed",
        },
      });
      expect(routeBody).not.toContain("emulator_console_auth_token");
      // Logged once, by the response, with the geo fix output as the cause.
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(errorLog.mock.calls[0]?.[0]).toBe(
        "[api] POST /api/route -> 502 adb emu geo fix failed:",
      );
      expect((errorLog.mock.calls[0]?.[1] as Error).cause).toMatchObject({
        message: `adb emu geo fix failed: ${geoFixOutput}`,
      });
      const status = await response(h.request("/api/route"));
      const statusBody = await status.text();
      expect(statusBody).toContain('"lastError":"adb emu geo fix failed"');
      expect(statusBody).not.toContain("emulator_console_auth_token");
    } finally {
      errorLog.mockRestore();
    }
  });

  test("POST /api/location honors record:false like every other action", async () => {
    const h = await createHarness({}, { setLocation: async () => {} });
    const post = (body: Record<string, unknown>) =>
      response(
        h.request("/api/location", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    expect((await post({ latitude: 37.5, longitude: 127, record: false })).status).toBe(200);
    const unrecorded = await (await response(h.request("/api/session"))).json();
    expect(unrecorded.session.eventCount).toBe(0);

    expect((await post({ latitude: 37.6, longitude: 127.1 })).status).toBe(200);
    const recorded = await (await response(h.request("/api/session"))).json();
    expect(recorded.session.eventCount).toBe(1);
    expect(recorded.events[0]).toMatchObject({
      kind: "location",
      location: { latitude: 37.6, longitude: 127.1 },
    });
  });

  test("route mutations on an ended session return 409, not 500", async () => {
    const h = await createHarness();
    h.session.endFrames();
    for (let turn = 0; turn < 20 && h.started.session !== null; turn++) {
      await Promise.resolve();
    }
    expect(h.started.session).toBeNull();

    const remove = await response(h.request("/api/route", { method: "DELETE" }));
    expect(remove.status).toBe(409);
    expect(await remove.json()).toMatchObject({
      ok: false,
      error: { code: "conflict", reason: "session_changed" },
    });

    const control = await response(
      h.request("/api/route/control", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "stop" }),
      }),
    );
    expect(control.status).toBe(409);
  });
});
