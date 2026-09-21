import { describe, expect, test } from "bun:test";
import {
  API_ERROR_CODES,
  API_SUCCESS_PARSERS,
  isApiFailure,
  parseApiFailure,
  parseApiResponse,
  parseDeviceGridResponse,
  parseHealthResponse,
  parseLogcatEventJson,
  type ApiPath,
  type ApiRequest,
  type ApiResponse,
} from "../src/shared/api-contracts.ts";

const routeSnapshot = {
  status: "running",
  waypointCount: 2,
  totalMeters: 100,
  progressMeters: 50,
  speedKph: 30,
  multiplier: 1,
  intervalMs: 1000,
  loop: false,
  startedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:01.000Z",
  pausedAt: null,
  completedAt: null,
  lastError: null,
  currentLocation: null,
};

describe("API contracts", () => {
  test("accepts every stable failure code and rejects drift", () => {
    for (const code of API_ERROR_CODES) {
      expect(parseApiFailure({ ok: false, error: { code, message: "safe" } })).toEqual({
        ok: false,
        error: { code, message: "safe" },
      });
    }
    expect(isApiFailure({ ok: false, error: { code: "bad_request", message: "old" } })).toBe(false);
    expect(() => parseApiFailure({ ok: false, error: "legacy" })).toThrow("invalid API failure");
  });

  test("validates required device-grid fields", () => {
    const response = parseDeviceGridResponse({
      ok: true,
      currentSerial: "emulator-5554",
      sessionStatus: "streaming",
      devices: [
        {
          id: "device:emulator-5554",
          kind: "emulator",
          serial: "emulator-5554",
          avd: "Pixel_8",
          name: "Pixel_8",
          state: "device",
          current: true,
          canSelect: true,
          canStart: false,
          canStop: true,
        },
      ],
    });
    expect(response.devices[0]?.current).toBe(true);
    expect(() => parseDeviceGridResponse({ ok: true, devices: [] })).toThrow("currentSerial");
  });

  test("the endpoint parser registry validates mutations and failures", () => {
    expect(parseApiResponse("/api/apps/launch", "POST", { ok: true, output: "started" })).toEqual({
      ok: true,
      output: "started",
    });
    expect(parseApiResponse("/api/route", "POST", { ok: true, route: routeSnapshot })).toEqual({
      ok: true,
      route: routeSnapshot,
    });
    expect(
      parseApiResponse("/api/network", "GET", {
        ok: false,
        error: { code: "downstream_failure", message: "adb unavailable" },
      }),
    ).toEqual({
      ok: false,
      error: { code: "downstream_failure", message: "adb unavailable" },
    });
    expect(() => parseApiResponse("/api/apps/launch", "POST", { ok: true })).toThrow("output");
  });

  test("request/response lookup types stay endpoint-specific", () => {
    const request: ApiRequest<"/api/location", "POST"> = {
      latitude: 51.5072,
      longitude: -0.1276,
    };
    const response: ApiResponse<"/api/tap", "POST"> = { ok: true };
    const paths: Record<ApiPath, true> = Object.fromEntries(
      Object.keys(API_SUCCESS_PARSERS).map((path) => [path, true]),
    ) as Record<ApiPath, true>;
    expect(request.latitude).toBe(51.5072);
    expect(response.ok).toBe(true);
    expect(Object.keys(paths).length).toBe(31);
  });

  test("validates health and logcat network boundaries without casts", () => {
    const session = {
      events: [],
      recording: true,
      replaying: false,
      replayStartedAt: null,
      replayCompletedAt: null,
      lastError: null,
    };
    const health = {
      ok: true,
      status: "streaming",
      serial: "emulator-5554",
      device: "Pixel",
      codec: "h264",
      size: { width: 1080, height: 1920 },
      clients: 0,
      frames: 1,
      sourceFps: 1,
      frameStats: null,
      configPackets: 1,
      droppedFrames: 0,
      backpressureEvents: 0,
      videoResetRequests: 0,
      lastVideoResetAt: null,
      lastVideoResetReason: null,
      location: null,
      route: { ...routeSnapshot, status: "idle" },
      session,
      clientsDetail: [],
      startedAt: "2026-01-01T00:00:00.000Z",
      stoppedAt: null,
      lastFrameAt: "2026-01-01T00:00:01.000Z",
      lastError: null,
      lastErrorCode: null,
      lastErrorMeta: null,
      sessionGeneration: 4,
    };

    expect(parseHealthResponse(health).sessionGeneration).toBe(4);
    expect(() => parseHealthResponse({ ...health, clientsDetail: [{}] })).toThrow(
      "clientsDetail[0].id",
    );
    expect(() => parseHealthResponse({ ...health, sessionGeneration: -1 })).toThrow(
      "non-negative safe integer",
    );
    expect(
      parseLogcatEventJson(
        "log",
        JSON.stringify({ line: "Activity started", at: health.startedAt }),
      ),
    ).toEqual({ line: "Activity started", at: health.startedAt });
    expect(() => parseLogcatEventJson("ready", '{"pids":[1]}')).toThrow(
      "serial",
    );
  });
});
