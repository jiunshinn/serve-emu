import { describe, expect, test } from "bun:test";
import {
  parseAccessibilitySnapshot,
  parseAccessibilityTapResponse,
  parseApiInfoResponse,
  parseApiResult,
  parseApiSuccess,
  parseAppActionResponse,
  parseAvdStartResponse,
  parseAvdStopResponse,
  parseDeviceListResponse,
  parseDeviceSelectionResponse,
  parseEmptyResponse,
  parseFileImportResponse,
  parseFontScaleResponse,
  parseForegroundResponse,
  parseHealthResponse,
  parseLocationResponse,
  parseLocationUpdateResponse,
  parseLogcatEvent,
  parseLogcatEventJson,
  parseNetworkResponse,
  parseNightModeResponse,
  parseOrientationResponse,
  parseRouteMutationResponse,
  parseRoutePlaybackSnapshot,
  parseScreenshotBase64Response,
  parseSessionMutationResponse,
  parseSessionSnapshot,
  type RoutePlaybackSnapshot,
  type SessionSnapshot,
} from "../src/shared/api-contracts.ts";

const timestamp = "2026-07-12T10:00:00.000Z";

const appliedLocation = {
  latitude: 51.5072,
  longitude: -0.1276,
  altitude: 35,
  satellites: 7,
  velocity: 2.5,
  appliedAt: timestamp,
};

const routeSnapshot: RoutePlaybackSnapshot = {
  status: "paused",
  waypointCount: 2,
  totalMeters: 125.5,
  progressMeters: 25.5,
  speedKph: 30,
  multiplier: 2,
  intervalMs: 500,
  loop: true,
  startedAt: timestamp,
  updatedAt: timestamp,
  pausedAt: timestamp,
  completedAt: null,
  lastError: null,
  currentLocation: appliedLocation,
};

const accessibilityNode = {
  id: "node-1",
  text: "Continue",
  contentDescription: "Continue to checkout",
  resourceId: "com.example:id/continue",
  className: "android.widget.Button",
  packageName: "com.example",
  clickable: true,
  enabled: true,
  bounds: { left: 10, top: 20, right: 210, bottom: 80 },
};

const sessionSnapshot: SessionSnapshot = {
  events: [
    {
      id: 1,
      at: timestamp,
      delayMs: 0,
      source: "rest",
      kind: "gesture",
      gesture: { type: "tap", x: 0.25, y: 0.75 },
    },
    {
      id: 2,
      at: timestamp,
      delayMs: 500,
      source: "route",
      kind: "location",
      location: {
        latitude: 51.5,
        longitude: -0.12,
        altitude: 10,
        satellites: 5,
        velocity: 1,
      },
    },
  ],
  recording: true,
  replaying: false,
  replayStartedAt: timestamp,
  replayCompletedAt: null,
  lastError: null,
};

describe("complete API success contracts", () => {
  test("parses discovery and device mutation payloads", () => {
    expect(
      parseApiInfoResponse({
        serial: "emulator-5554",
        device: "Pixel 8",
        codec: "h264",
        size: { width: 1080, height: 1920 },
        status: "streaming",
        clients: 2,
      }),
    ).toEqual({
      serial: "emulator-5554",
      device: "Pixel 8",
      codec: "h264",
      size: { width: 1080, height: 1920 },
      status: "streaming",
      clients: 2,
    });
    expect(
      parseDeviceListResponse({
        ok: true,
        currentSerial: "emulator-5554",
        devices: [
          { serial: "emulator-5554", state: "device", current: true },
          { serial: "offline-device", state: "offline", current: false },
        ],
      }).devices,
    ).toHaveLength(2);
    expect(
      parseDeviceSelectionResponse({
        ok: true,
        serial: "emulator-5554",
        device: "Pixel 8",
      }),
    ).toEqual({ ok: true, serial: "emulator-5554", device: "Pixel 8" });
    expect(
      parseAvdStartResponse({
        ok: true,
        serial: "emulator-5556",
        avd: "Pixel_9",
        device: "Pixel 9",
      }),
    ).toEqual({
      ok: true,
      serial: "emulator-5556",
      avd: "Pixel_9",
      device: "Pixel 9",
    });
    expect(
      parseAvdStartResponse({ ok: true, serial: "emulator-5556", avd: "Pixel_9" }),
    ).toEqual({ ok: true, serial: "emulator-5556", avd: "Pixel_9" });
    expect(parseAvdStopResponse({ ok: true, serial: "emulator-5556" })).toEqual({
      ok: true,
      serial: "emulator-5556",
    });
  });

  test("parses orientation, appearance, and network status payloads", () => {
    expect(
      parseOrientationResponse({
        ok: true,
        orientation: {
          mode: "lock",
          rotation: 1,
          orientation: "landscape",
          raw: "1",
        },
      }).orientation,
    ).toMatchObject({ mode: "lock", rotation: 1, orientation: "landscape" });
    expect(
      parseOrientationResponse({
        ok: true,
        orientation: {
          mode: "unknown",
          rotation: null,
          orientation: "unknown",
          raw: "",
        },
      }).orientation.rotation,
    ).toBeNull();
    expect(
      parseNightModeResponse({
        ok: true,
        nightMode: { mode: "dark", raw: "yes" },
      }).nightMode,
    ).toEqual({ mode: "dark", raw: "yes" });
    expect(
      parseFontScaleResponse({
        ok: true,
        fontScale: { scale: 1.15, raw: "1.15" },
      }).fontScale.scale,
    ).toBe(1.15);
    expect(
      parseNetworkResponse({
        ok: true,
        network: {
          enabled: null,
          wifi: "enabled",
          mobileData: "unknown",
          raw: { wifi: "1", mobileData: "null" },
        },
      }).network,
    ).toEqual({
      enabled: null,
      wifi: "enabled",
      mobileData: "unknown",
      raw: { wifi: "1", mobileData: "null" },
    });
  });

  test("parses foreground and accessibility inspection payloads", () => {
    expect(
      parseForegroundResponse({
        ok: true,
        app: {
          packageName: "com.example",
          activity: "com.example.MainActivity",
          pid: 1234,
          label: "Example",
          versionName: "1.2.3",
          versionCode: "42",
          debuggable: false,
        },
      }).app,
    ).toMatchObject({ packageName: "com.example", pid: 1234, debuggable: false });
    expect(
      parseForegroundResponse({
        ok: true,
        app: {
          packageName: null,
          activity: null,
          pid: null,
          label: null,
          versionName: null,
          versionCode: null,
          debuggable: null,
        },
      }).app.packageName,
    ).toBeNull();

    const snapshot = parseAccessibilitySnapshot({
      ok: true,
      capturedAt: timestamp,
      nodes: [accessibilityNode],
    });
    expect(snapshot.nodes[0]).toEqual(accessibilityNode);
    expect(
      parseAccessibilityTapResponse({
        ok: true,
        capturedAt: timestamp,
        node: accessibilityNode,
      }).node.resourceId,
    ).toBe(accessibilityNode.resourceId);
  });

  test("parses complete location and route payloads", () => {
    expect(
      parseLocationResponse({
        serial: "emulator-5554",
        emulator: true,
        location: null,
      }).location,
    ).toBeNull();
    expect(
      parseLocationResponse({
        serial: "emulator-5554",
        emulator: true,
        location: appliedLocation,
      }).location,
    ).toEqual(appliedLocation);
    expect(
      parseLocationUpdateResponse({ ok: true, location: appliedLocation }).location,
    ).toEqual(appliedLocation);
    expect(parseRoutePlaybackSnapshot(routeSnapshot)).toEqual(routeSnapshot);
    expect(
      parseRouteMutationResponse({ ok: true, route: routeSnapshot }).route,
    ).toEqual(routeSnapshot);
  });

  test("parses both recorded event variants and session mutations", () => {
    const parsed = parseSessionSnapshot(sessionSnapshot);
    expect(parsed.events).toHaveLength(2);
    expect(parsed.events[0]).toMatchObject({ kind: "gesture", gesture: { type: "tap" } });
    expect(parsed.events[1]).toEqual(sessionSnapshot.events[1]);
    expect(
      parseSessionMutationResponse({ ok: true, session: sessionSnapshot }).session,
    ).toEqual(parsed);
  });

  test("parses simple action, import, screenshot, and logcat payloads", () => {
    expect(parseEmptyResponse({ ok: true })).toEqual({ ok: true });
    expect(parseAppActionResponse({ ok: true, output: "started" })).toEqual({
      ok: true,
      output: "started",
    });
    expect(
      parseFileImportResponse({
        ok: true,
        output: "pushed",
        path: "/sdcard/Download/photo.png",
        kind: "image",
      }),
    ).toMatchObject({ kind: "image", output: "pushed" });
    expect(
      parseScreenshotBase64Response({ ok: true, mimeType: "image/png", data: "iVBORw==" }),
    ).toEqual({ ok: true, mimeType: "image/png", data: "iVBORw==" });

    expect(
      parseLogcatEvent("ready", {
        serial: "emulator-5554",
        package: null,
        pids: ["10", "11"],
        search: null,
      }),
    ).toMatchObject({ serial: "emulator-5554", pids: ["10", "11"] });
    expect(parseLogcatEvent("error", { line: "denied", at: timestamp })).toEqual({
      line: "denied",
      at: timestamp,
    });
    expect(parseLogcatEvent("close", { code: null, signal: "SIGTERM" })).toEqual({
      code: null,
      signal: "SIGTERM",
    });
    expect(parseLogcatEvent("close", { code: 0, signal: null })).toEqual({
      code: 0,
      signal: null,
    });
    expect(() => parseLogcatEventJson("log", "not-json")).toThrow("valid JSON");
  });
});

describe("generic and detailed API contracts", () => {
  test("routes success and failure envelopes through parseApiResult", () => {
    const parseValue = (value: unknown) => {
      const root = value as { ok: true; value: number };
      return { ok: true as const, value: root.value };
    };
    expect(parseApiResult({ ok: true, value: 4 }, parseValue)).toEqual({
      ok: true,
      value: 4,
    });
    expect(
      parseApiResult(
        { ok: false, error: { code: "conflict", message: "busy" } },
        parseValue,
      ),
    ).toEqual({ ok: false, error: { code: "conflict", message: "busy" } });
  });

  test("parses health diagnostics including frame stats, clients, and error metadata", () => {
    const health = parseHealthResponse({
      ok: true,
      status: "streaming",
      serial: "emulator-5554",
      device: "Pixel 8",
      codec: "h264",
      size: { width: 1080, height: 1920 },
      clients: 1,
      frames: 120,
      sourceFps: 60,
      frameStats: {
        windowFrames: 60,
        intervalMs: { p50: 16.6, p95: 20.1, max: 25.2 },
        avgKeyFrameBytes: 50_000,
        avgDeltaFrameBytes: 4_000,
        keyFramesInWindow: 2,
      },
      configPackets: 2,
      droppedFrames: 3,
      backpressureEvents: 1,
      videoResetRequests: 1,
      lastVideoResetAt: timestamp,
      lastVideoResetReason: "backpressure",
      location: appliedLocation,
      route: routeSnapshot,
      session: sessionSnapshot,
      clientsDetail: [
        {
          id: 7,
          frameMeta: true,
          sentFrames: 100,
          droppedFrames: 3,
          backpressureEvents: 1,
          bufferedBytes: 1024,
          awaitingKeyFrame: false,
        },
      ],
      startedAt: timestamp,
      stoppedAt: null,
      lastFrameAt: timestamp,
      lastError: "temporary",
      lastErrorCode: "socket",
      lastErrorMeta: { attempt: 2, phase: "connect" },
      sessionGeneration: 3,
    });

    expect(health.frameStats?.intervalMs?.p95).toBe(20.1);
    expect(health.frameStats?.avgKeyFrameBytes).toBe(50_000);
    expect(health.clientsDetail[0]).toMatchObject({ id: 7, frameMeta: true });
    expect(health.lastErrorMeta).toEqual({ attempt: 2, phase: "connect" });
    expect(health.sessionGeneration).toBe(3);
  });

  test("supports binary screenshots and rejects streaming JSON through the registry", () => {
    const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47);
    expect(parseApiSuccess("/api/screenshot", "GET", png)).toBe(png);
    expect(() => parseApiSuccess("/api/logcat", "GET", {})).toThrow(
      "streaming responses are not JSON API payloads",
    );
  });
});

describe("API parser rejection boundaries", () => {
  test("rejects invalid primitives, dimensions, discriminants, and nested collections", () => {
    expect(() => parseApiInfoResponse([])).toThrow("must be an object");
    expect(() =>
      parseApiInfoResponse({
        serial: "a",
        device: "d",
        codec: "h264",
        size: { width: 0, height: 1 },
        status: "streaming",
        clients: 0,
      }),
    ).toThrow("dimensions must be positive");
    expect(() => parseDeviceListResponse({ ok: true, devices: {} })).toThrow("must be an array");
    expect(() => parseAccessibilitySnapshot({ ok: true, nodes: {} })).toThrow("must be an array");
    expect(() => parseSessionSnapshot({ ...sessionSnapshot, events: [{ ...sessionSnapshot.events[0], kind: "unknown" }] })).toThrow(
      "kind is invalid",
    );
    expect(() =>
      parseFileImportResponse({ ok: true, output: "x", path: "/x", kind: "apk" }),
    ).toThrow("kind is invalid");
    expect(() =>
      parseScreenshotBase64Response({ ok: true, mimeType: "image/jpeg", data: "x" }),
    ).toThrow("must be image/png");
  });
});
