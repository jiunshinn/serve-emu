import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { LogcatHub } from "../src/logcat.ts";
import { RoutePlayback } from "../src/route-playback.ts";
import {
  parseApiResponse,
  parseHealthResponse,
  parseLogcatEventJson,
  parseRoutePlaybackSnapshot,
  type ApiMethod,
  type ApiPath,
  type LogcatEventMap,
} from "../src/shared/api-contracts.ts";
import {
  createHarness,
  fakeScrcpy,
  response,
} from "./helpers/server-harness.ts";

// The shared parsers are what the UI client trusts; these tests feed them the
// server's real responses instead of hand-written fixtures, so a field renamed
// on either side fails here.

const node = {
  id: "0",
  text: "OK",
  contentDescription: "",
  resourceId: "android:id/button1",
  className: "android.widget.Button",
  packageName: "com.example",
  clickable: true,
  enabled: true,
  bounds: { left: 100, top: 200, right: 300, bottom: 260 },
};

async function liveHarness() {
  const stopped: string[] = [];
  const h = await createHarness({}, {
    openScrcpy: async (serial) => fakeScrcpy(serial),
    listDevices: async () => [
      { serial: "emulator-5554", state: "device" },
      { serial: "emulator-5556", state: "device" },
      { serial: "emulator-5558", state: "device" },
    ],
    listRunningAvds: async () => [
      { serial: "emulator-5558", avd: "Running_AVD", state: "device" },
    ],
    listAvds: async () => ["Running_AVD", "Stopped_AVD"],
    startEmulator: async (opts) => ({
      serial: opts.avd === "Selected_AVD" ? "emulator-5556" : "emulator-5560",
      proc: null,
      ownsProcess: true,
      stop: () => {},
    }),
    stopEmulator: async (serial) => {
      stopped.push(serial);
    },
    setLocation: async () => {},
    loadAccessibility: async () => ({
      ok: true,
      capturedAt: new Date().toISOString(),
      nodes: [node],
    }),
    stageMultipartUpload: async (_request, options) => ({
      path: "/tmp/serve-emu-upload-test/upload.bin",
      filename: options.fieldName === "apk" ? "app.apk" : "photo.png",
      mediaType: "application/octet-stream",
      size: 4,
      cleanup: async () => {},
    }),
    installApk: async () => ({ ok: true, output: "Success" }),
    importMediaFile: async () => ({
      ok: true,
      output: "Imported photo.png to /sdcard/Pictures/photo.png",
      path: "/sdcard/Pictures/photo.png",
      kind: "image",
    }),
  });

  async function call<P extends ApiPath, M extends ApiMethod<P>>(
    path: P,
    method: M,
    body?: unknown,
    query = "",
  ) {
    const res = await response(
      h.request(`${path}${query}`, {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
      }),
    );
    const payload = (await res.json()) as unknown;
    expect({ path, method, status: res.status }).toEqual({
      path,
      method,
      status: 200,
    });
    return parseApiResponse(path, method, payload);
  }

  async function uploadPayload(
    path: "/api/apps/install" | "/api/files/import",
  ): Promise<unknown> {
    const res = await response(
      h.request(path, {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=live" },
        body: "--live--\r\n",
      }),
    );
    expect(res.status).toBe(200);
    return res.json();
  }

  return { h, call, uploadPayload, stopped };
}

describe("shared API contracts against real server responses", () => {
  test("device, input, accessibility, and upload endpoints", async () => {
    const { h, call, uploadPayload, stopped } = await liveHarness();

    expect(await call("/api", "GET")).toMatchObject({ serial: "emulator-5554" });
    expect(await call("/api/devices", "GET")).toMatchObject({
      currentSerial: "emulator-5554",
    });
    expect(await call("/api/device-grid", "GET")).toMatchObject({
      ok: true,
      sessionStatus: "streaming",
    });

    for (const [path, body] of [
      ["/api/tap", { x: 0.5, y: 0.5 }],
      ["/api/swipe", { x1: 0.5, y1: 0.8, x2: 0.5, y2: 0.2, durationMs: 50 }],
      ["/api/text", { text: "hello" }],
      ["/api/key", { key: "home" }],
    ] as const) {
      expect(await call(path, "POST", body)).toMatchObject({ ok: true });
    }

    expect(await call("/api/accessibility", "GET")).toMatchObject({
      nodes: [{ resourceId: "android:id/button1" }],
    });
    expect(
      await call("/api/accessibility/tap", "POST", { selector: { text: "OK" } }),
    ).toMatchObject({ node: { text: "OK" } });

    expect(
      parseApiResponse(
        "/api/apps/install",
        "POST",
        await uploadPayload("/api/apps/install"),
      ),
    ).toEqual({ ok: true, output: "Success" });
    expect(
      parseApiResponse(
        "/api/files/import",
        "POST",
        await uploadPayload("/api/files/import"),
      ),
    ).toMatchObject({ kind: "image" });

    expect(
      await call("/api/avds/start", "POST", { avd: "Background_AVD", select: false }),
    ).toEqual({ ok: true, serial: "emulator-5560", avd: "Background_AVD" });
    expect(
      await call("/api/avds/stop", "POST", { serial: "emulator-5558" }),
    ).toEqual({ ok: true, serial: "emulator-5558" });
    expect(stopped).toEqual(["emulator-5558"]);

    expect(
      await call("/api/devices/select", "POST", { serial: "emulator-5556" }),
    ).toMatchObject({ serial: "emulator-5556", generation: 1 });
    expect(
      await call("/api/avds/start", "POST", { avd: "Selected_AVD" }),
    ).toMatchObject({ serial: "emulator-5556", avd: "Selected_AVD" });

    const health = await response(h.request("/health"));
    expect(health.status).toBe(200);
    expect(parseHealthResponse(await health.json())).toMatchObject({
      serial: "emulator-5556",
      generation: 1,
      session: { eventCount: 0 },
    });
  });

  test("location, route, and session endpoints", async () => {
    const { h, call } = await liveHarness();
    const fix = { latitude: 37.5665, longitude: 126.978 };

    expect(await call("/api/location", "GET")).toMatchObject({ location: null });
    expect(await call("/api/location", "POST", fix)).toMatchObject({
      location: fix,
    });
    expect(await call("/api/route", "GET")).toMatchObject({ status: "idle" });
    expect(
      await call("/api/route", "POST", {
        waypoints: [fix, { latitude: 37.57, longitude: 126.98 }],
        speedKph: 30,
      }),
    ).toMatchObject({ route: { waypointCount: 2 } });
    expect(
      await call("/api/route/control", "POST", { action: "pause" }),
    ).toMatchObject({ route: { status: "paused" } });
    expect(await call("/api/route", "DELETE")).toMatchObject({
      route: { status: "idle" },
    });

    await call("/api/tap", "POST", { x: 0.25, y: 0.75 });
    const page = await call("/api/session", "GET", undefined, "?limit=1");
    expect(page).toMatchObject({
      session: { eventCount: 2, recording: true },
      hasMore: true,
    });
    expect(await call("/api/session/export", "GET")).toMatchObject({
      events: [{ kind: "location" }, { kind: "gesture" }],
    });
    expect(
      await call("/api/session/replay", "POST", { multiplier: 20 }),
    ).toMatchObject({ session: { replaying: true, replayStatus: "running" } });
    expect(await call("/api/session/replay/stop", "POST")).toMatchObject({
      session: { replaying: false },
    });
    expect(await call("/api/session", "DELETE")).toMatchObject({
      session: { eventCount: 0 },
    });

    const health = await response(h.request("/health"));
    expect(parseHealthResponse(await health.json())).toMatchObject({
      generation: 0,
      route: { status: "idle" },
    });
  });

  test("route playback closed with its device session", () => {
    const route = new RoutePlayback({
      applyLocation: async () => {},
      onLocation: () => {},
    });
    route.close();
    expect(parseRoutePlaybackSnapshot(route.snapshot()).status).toBe("closed");
  });

  test("logcat server-sent events", async () => {
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr: new PassThrough(),
      pid: 4242,
      exitCode: null as number | null,
      kill: () => true,
    });
    const hub = new LogcatHub("emulator-5554", {
      batchIntervalMs: 1,
      dependencies: { spawn: () => child as never },
    });
    const res = hub.subscribe({});
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const readUntil = async (marker: string) => {
      while (!text.includes(marker)) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value);
      }
    };
    stdout.write("10-10 09:00:00.000  1  1 I Test: hello\n");
    await readUntil("event: logs");
    hub.close("device session ended");
    await readUntil("event: close");

    const events = [...text.matchAll(/event: (\w+)\ndata: (.*)\n\n/g)];
    const parsed = events.map(([, event, data]) =>
      parseLogcatEventJson(event as keyof LogcatEventMap, data!),
    );
    expect(events.map(([, event]) => event)).toEqual(["ready", "logs", "close"]);
    expect(parsed[0]).toMatchObject({ serial: "emulator-5554", package: null });
    expect(parsed[1]).toMatchObject({
      lines: [{ line: expect.stringContaining("hello") }],
    });
    expect(parsed[2]).toEqual({ reason: "device session ended" });
  });
});
