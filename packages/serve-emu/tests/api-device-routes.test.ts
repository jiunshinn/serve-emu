import { describe, expect, test } from "bun:test";
import type { ApiDependencies } from "../src/api/dependencies.ts";
import { locationRoutes } from "../src/api/routes/location.ts";
import { DeviceSessionManager, SessionChangedError } from "../src/device-session-context.ts";
import type { DeviceService } from "../src/device-service.ts";
import type { GeoFix } from "../src/location.ts";
import { RoutePlayback } from "../src/route-playback.ts";
import type { DeviceContext } from "../src/server/types.ts";
import { createHarness, fakeScrcpy, response, waitFor } from "./helpers/server-harness.ts";

const ORIGIN = "http://127.0.0.1:33040";
const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", origin: ORIGIN },
  body: JSON.stringify(body),
});

type Call = { method: string; serial: string; args: unknown[]; signal: AbortSignal };

/** A device service whose every method records its call and resolves as told. */
function fakeDevice(result: (method: string, signal: AbortSignal) => Promise<unknown> = async () => ({})) {
  const calls: Call[] = [];
  const service = new Proxy({} as DeviceService, {
    get: (_target, method: string) =>
      (serial: string, ...rest: unknown[]) => {
        const signal = rest.pop() as AbortSignal;
        calls.push({ method, serial, args: rest, signal });
        return result(method, signal);
      },
  });
  return { calls, service };
}

const untilAborted = (signal: AbortSignal) =>
  new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

describe("device routes use the injected device service", () => {
  test("settings, screenshot, foreground, and app routes pass the session signal", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const device = fakeDevice(async (method) =>
      method === "screenshot" ? png : { ok: true, method },
    );
    const h = await createHarness({}, { deviceService: device.service });
    const serial = h.started.session!.serial;

    expect((await response(h.request("/api/orientation"))).status).toBe(200);
    expect((await response(h.request("/api/orientation", post({ orientation: "landscape" })))).status).toBe(200);
    expect((await response(h.request("/api/night-mode", post({ mode: "dark" })))).status).toBe(200);
    expect((await response(h.request("/api/font-scale", post({ scale: 1.3 })))).status).toBe(200);
    expect((await response(h.request("/api/network", post({ enabled: false })))).status).toBe(200);
    expect(await (await response(h.request("/api/foreground"))).json()).toMatchObject({ ok: true });
    for (const method of ["GET", "POST"]) {
      const shot = await response(h.request("/api/screenshot", { method, headers: { origin: ORIGIN } }));
      expect(new Uint8Array(await shot.arrayBuffer())).toEqual(new Uint8Array(png));
    }
    expect(await (await response(h.request("/api/screenshot?format=base64"))).json()).toEqual({
      ok: true,
      mimeType: "image/png",
      data: png.toString("base64"),
    });
    for (const [path, body] of [
      ["/api/apps/launch", { packageName: "com.example.app", activity: ".Main" }],
      ["/api/apps/clear", { packageName: "com.example.app" }],
      ["/api/apps/force-stop", { packageName: "com.example.app" }],
      ["/api/apps/grant", { packageName: "com.example.app", permission: "android.permission.CAMERA" }],
    ] as const) {
      expect((await response(h.request(path, post(body)))).status, path).toBe(200);
    }

    expect(device.calls.map((call) => [call.method, call.args])).toEqual([
      ["orientation", []],
      ["setOrientation", ["landscape"]],
      ["setNightMode", ["dark"]],
      ["setFontScale", [1.3]],
      ["setNetwork", [false]],
      ["foregroundApp", []],
      ["screenshot", []],
      ["screenshot", []],
      ["screenshot", []],
      ["launchApp", ["com.example.app", ".Main"]],
      ["clearAppData", ["com.example.app"]],
      ["forceStopApp", ["com.example.app"]],
      ["grantPermission", ["com.example.app", "android.permission.CAMERA"]],
    ]);
    expect(device.calls.every((call) => call.serial === serial)).toBe(true);
    expect(device.calls.every((call) => call.signal instanceof AbortSignal && !call.signal.aborted)).toBe(true);
  });

  test("a device switch aborts an in-flight command and answers 409", async () => {
    const device = fakeDevice(async (_method, signal) => untilAborted(signal));
    const sessions = new Map([
      ["device-a", fakeScrcpy("device-a")],
      ["device-b", fakeScrcpy("device-b")],
    ]);
    const h = await createHarness({ serial: "device-a" }, {
      deviceService: device.service,
      openScrcpy: async (serial) => sessions.get(serial)! as never,
      listDevices: async () => [
        { serial: "device-a", state: "device" },
        { serial: "device-b", state: "device" },
      ],
    });
    const screenshot = response(h.request("/api/screenshot"));
    await waitFor(() => device.calls.length === 1);
    expect(device.calls[0]!.signal.aborted).toBe(false);

    const switched = await response(h.request("/api/devices/select", post({ serial: "device-b" })));
    expect(switched.status).toBe(200);
    expect(device.calls[0]!.signal.aborted).toBe(true);
    const stale = await screenshot;
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ ok: false, code: "session_changed" });
  });

  test("a client that goes away aborts its command", async () => {
    const device = fakeDevice(async (_method, signal) => untilAborted(signal));
    const h = await createHarness({}, { deviceService: device.service });
    const client = new AbortController();
    const pending = h.request("/api/foreground", { signal: client.signal });
    await waitFor(() => device.calls.length === 1);
    client.abort();
    await pending.catch(() => {});
    expect(device.calls[0]!.signal.aborted).toBe(true);
  });

  test("a device command failure is an error response, not a crash", async () => {
    const device = fakeDevice(async () => {
      throw new Error("wm failed");
    });
    const h = await createHarness({}, { deviceService: device.service });
    const failed = await response(h.request("/api/orientation"));
    expect(failed.status).toBe(400);
    expect(await failed.json()).toMatchObject({ ok: false, error: "wm failed" });
  });
});

describe("REST and replay apply a location through one helper", () => {
  test("REST records the fix; replay applies it without recording", async () => {
    const applied: Array<{ serial: string; fix: GeoFix }> = [];
    const h = await createHarness({}, {
      setLocation: async (serial, fix) => {
        applied.push({ serial, fix });
      },
    });
    const set = await response(h.request("/api/location", post({ latitude: 35.17, longitude: 129.07 })));
    expect(set.status).toBe(200);
    const recorded = await (await response(h.request("/api/session"))).json();
    expect(recorded.session.eventCount).toBe(1);

    const replay = await response(h.request("/api/session/replay", post({ multiplier: 100 })));
    expect(replay.status).toBe(200);
    await waitFor(async () => !(await (await response(h.request("/api/session"))).json()).session.replaying);

    expect(applied).toHaveLength(2);
    expect(applied[1]!.fix).toMatchObject({ latitude: 35.17, longitude: 129.07 });
    const after = await (await response(h.request("/api/session"))).json();
    expect(after.session.eventCount).toBe(1);
    const location = await (await response(h.request("/api/location"))).json();
    expect(location.location).toMatchObject({ latitude: 35.17, longitude: 129.07 });
  });
});

describe("POST /api/route", () => {
  test("a session change after the start resolves answers through errorResponse", async () => {
    const session = new AbortController();
    const playback = new RoutePlayback({ applyLocation: () => {}, onLocation: () => {} });
    const context = {
      serial: "emulator-5554",
      generation: 1,
      signal: session.signal,
      dispose: async () => {},
      route: playback,
      // The device switches in the gap between the start resolving and the
      // handler resuming.
      trackDrain: <T>(start: Promise<T>) =>
        start.then((route) => {
          session.abort();
          return route;
        }),
    } as unknown as DeviceContext;
    const handled: unknown[] = [];
    const answered = Response.json({ ok: false, code: "session_changed" }, { status: 409 });
    const deps = {
      requestContext: context,
      sessions: new DeviceSessionManager(context),
      readJsonBody: (req: Request) => req.json(),
      MAX_ROUTE_BODY_BYTES: 1_024,
      errorResponse: (err: unknown) => {
        handled.push(err);
        return answered;
      },
    } as unknown as ApiDependencies;
    const route = locationRoutes().find((r) => r.method === "POST" && r.path === "/api/route")!;
    const request = new Request("http://127.0.0.1/api/route", post({ waypoints: [{ latitude: 51.5, longitude: -0.1 }] }));

    const res = await route.handler({ request, url: new URL(request.url), deps });
    expect(res).toBe(answered);
    expect(handled).toHaveLength(1);
    expect(handled[0]).toBeInstanceOf(SessionChangedError);
    expect(handled[0]).toMatchObject({ code: "session_changed", expectedGeneration: 1 });
    playback.close();
  });
});
