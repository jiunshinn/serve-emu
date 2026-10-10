import { EventEmitter } from "node:events";
import { describe, expect, spyOn, test } from "bun:test";
import { startServer } from "../src/server.ts";
import { parseDeviceGridResponse } from "../src/shared/api-contracts.ts";
import type { EmulatorLaunch } from "../src/emulator.ts";
import type { GeoFix } from "../src/location.ts";
import { deferred } from "./helpers/deferred.ts";
import {
  createHarness,
  fakeScrcpy,
  response,
} from "./helpers/server-harness.ts";

describe("startServer device session lifecycle", () => {
  test("rolls back the initial scrcpy session when the HTTP bind fails", async () => {
    const initial = fakeScrcpy("A");

    // startServer itself must reject, so there is no harness to return.
    await expect(
      startServer(
        { serial: "A", port: 3300 },
        {
          log: () => {},
          openScrcpy: async () => initial,
          serve: (() => {
            throw new Error("EADDRINUSE");
          }) as unknown as typeof Bun.serve,
        },
      ),
    ).rejects.toThrow("EADDRINUSE");
    expect(initial.closeCalls).toBe(1);
  });

  test("returns 409 for an old location completion and exposes only the new session", async () => {
    const oldLocation = deferred<void>();
    const oldLocationStarted = deferred<void>();
    const locationCalls: Array<{ serial: string; fix: GeoFix }> = [];
    // Names and sizes unlike each other's show which session /health reports.
    const a = fakeScrcpy("A", {
      meta: { deviceName: "device-A", width: 1080, height: 1920 },
    });
    const b = fakeScrcpy("B", {
      meta: { deviceName: "device-B", width: 720, height: 1280 },
    });
    const h = await createHarness(
      { sessions: [a, b] },
      {
        listRunningAvds: async () => [],
        listAvds: async () => [],
        setLocation: async (serial, fix) => {
          locationCalls.push({ serial, fix });
          if (serial === "A") {
            oldLocationStarted.resolve();
            await oldLocation.promise;
          }
        },
      },
    );
    const started = h.started;

    expect(started.session).toBe(a);
    const oldRequest = response(
      h.request("/api/location", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ latitude: 51.5, longitude: -0.1 }),
      }),
    );
    await oldLocationStarted.promise;

    const switchResponse = await response(
      h.request("/api/devices/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serial: "B" }),
      }),
    );
    expect(switchResponse.status).toBe(200);
    expect(started.session).toBe(b);
    expect(started.session).toBe(b);
    expect(a.closeCalls).toBe(1);

    oldLocation.resolve();
    const staleResponse = await oldRequest;
    expect(staleResponse.status).toBe(409);
    expect(await staleResponse.json()).toMatchObject({
      ok: false,
      error: { code: "conflict", reason: "session_changed" },
    });
    expect(locationCalls).toEqual([
      {
        serial: "A",
        fix: {
          latitude: 51.5,
          longitude: -0.1,
          altitude: undefined,
          satellites: undefined,
          velocity: undefined,
        },
      },
    ]);

    const healthResponse = await response(h.request("/health"));
    expect(healthResponse.status).toBe(200);
    expect(await healthResponse.json()).toMatchObject({
      generation: 1,
      serial: "B",
      device: "device-B",
      size: { width: 720, height: 1280 },
      location: null,
    });
    const gridResponse = await response(h.request("/api/device-grid"));
    expect(gridResponse.status).toBe(200);
    expect(await gridResponse.json()).toMatchObject({
      currentSerial: "B",
      sessionStatus: "streaming",
    });

    await started.stop();
    expect(started.session).toBeNull();
    expect(b.closeCalls).toBe(1);
    expect(h.server.stopArguments).toHaveLength(1);
  });

  test("cancels an old route start when the device session changes", async () => {
    const routeLocationStarted = deferred<void>();
    let routeSignal = null as AbortSignal | null;
    const h = await createHarness(
      { serials: ["A", "B"] },
      {
        setLocation: async (serial, _fix, signal) => {
          if (serial !== "A") return;
          routeSignal = signal;
          routeLocationStarted.resolve();
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(signal.reason),
              { once: true },
            );
          });
        },
      },
    );

    const oldRoute = response(
      h.request("/api/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          waypoints: [{ latitude: 51.5, longitude: -0.1 }],
        }),
      }),
    );
    await routeLocationStarted.promise;

    const switchResponse = await response(
      h.request("/api/devices/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serial: "B" }),
      }),
    );
    expect(switchResponse.status).toBe(200);
    expect(routeSignal?.aborted).toBe(true);

    const staleResponse = await oldRoute;
    expect(staleResponse.status).toBe(409);
    expect(await staleResponse.json()).toMatchObject({ ok: false });
    const healthResponse = await response(h.request("/health"));
    expect(await healthResponse.json()).toMatchObject({
      generation: 1,
      serial: "B",
      route: { status: "idle" },
    });
    await h.started.stop();
  });

  test("rejects a request whose body finishes after the device changes", async () => {
    const bodyGate = deferred<string>();
    const locationCalls: string[] = [];
    const h = await createHarness(
      { serials: ["A", "B"] },
      {
        setLocation: async (serial) => {
          locationCalls.push(serial);
        },
      },
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        void bodyGate.promise.then((value) => {
          controller.enqueue(new TextEncoder().encode(value));
          controller.close();
        });
      },
    });
    const slowRequest = response(
      h.request("/api/location", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      }),
    );
    await Promise.resolve();

    const switchResponse = await response(
      h.request("/api/devices/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serial: "B" }),
      }),
    );
    expect(switchResponse.status).toBe(200);
    bodyGate.resolve(JSON.stringify({ latitude: 51.5, longitude: -0.1 }));

    const slowResponse = await slowRequest;
    expect(slowResponse.status).toBe(409);
    expect(await slowResponse.json()).toMatchObject({
      error: { code: "conflict", reason: "session_changed" },
    });
    expect(locationCalls).toEqual([]);
    await h.started.stop();
  });

  test("a stale AVD boot cannot replace a newer selected device", async () => {
    const launchGate = deferred<EmulatorLaunch>();
    const launchStarted = deferred<void>();
    let launchStopCalls = 0;
    // Adb also lists C, which has no scrcpy session: opening it would throw.
    const h = await createHarness(
      { serials: ["A", "B"] },
      {
        listDevices: async () => [
          { serial: "A", state: "device" },
          { serial: "B", state: "device" },
          { serial: "C", state: "device" },
        ],
        startEmulator: async () => {
          launchStarted.resolve();
          return launchGate.promise;
        },
      },
    );
    const staleStart = response(
      h.request("/api/avds/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avd: "Pixel_API", select: true }),
      }),
    );
    await launchStarted.promise;

    const switchResponse = await response(
      h.request("/api/devices/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serial: "B" }),
      }),
    );
    expect(switchResponse.status).toBe(200);
    launchGate.resolve({
      serial: "C",
      proc: null,
      ownsProcess: true,
      stop: async () => {
        launchStopCalls += 1;
      },
    });

    const staleResponse = await staleStart;
    expect(staleResponse.status).toBe(409);
    expect(await staleResponse.json()).toMatchObject({
      error: { code: "conflict", reason: "session_changed" },
    });
    expect(launchStopCalls).toBe(1);
    expect(h.openCalls).toEqual(["A", "B"]);
    expect(h.started.session).toBe(h.sessions.get("B")!);
    await h.started.stop();
  });

  test("device discovery and selection remain available after terminal EOF", async () => {
    const h = await createHarness({ serials: ["A", "B"] });
    const started = h.started;

    h.session.endFrames();
    for (let turn = 0; turn < 20 && started.session !== null; turn++) {
      await Promise.resolve();
    }
    expect(started.session).toBeNull();
    const devicesResponse = await response(h.request("/api/devices"));
    expect(devicesResponse.status).toBe(200);
    expect(await devicesResponse.json()).toMatchObject({ currentSerial: "A" });

    const switchResponse = await response(
      h.request("/api/devices/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serial: "B" }),
      }),
    );
    expect(switchResponse.status).toBe(200);
    expect(started.session).toBe(h.sessions.get("B")!);
    await started.stop();
  });

  test("keeps serving when the previous session's scrcpy cleanup fails", async () => {
    const h = await createHarness({ serials: ["A", "B"] });
    const a = h.session;
    const b = h.sessions.get("B")!;
    const cleanupError = new AggregateError(
      [new Error("adb: device unauthorized")],
      "scrcpy cleanup failed",
    );
    // Like the real session: sockets close at once (ending the stream), and
    // the adb cleanup that follows rejects.
    a.close = () => {
      a.endFrames();
      return Promise.reject(cleanupError);
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    try {
      const switchResponse = await response(
        h.request("/api/devices/select", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ serial: "B" }),
        }),
      );
      expect(switchResponse.status).toBe(200);
      await Bun.sleep(0);
      expect(unhandled).toEqual([]);
      expect(errorLog).toHaveBeenCalledWith(
        "[scrcpy] cleanup failed for A:",
        cleanupError,
      );

      const health = await response(h.request("/health"));
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ serial: "B", generation: 1 });
      await h.started.stop();
      expect(b.closeCalls).toBe(1);
    } finally {
      errorLog.mockRestore();
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("stops emulators it launched when the server stops, not attached ones", async () => {
    const stops: string[] = [];
    const killed: string[] = [];
    const h = await createHarness(
      { serials: ["A"] },
      {
        startEmulator: async ({ avd }) => ({
          serial: avd === "Owned" ? "emulator-5556" : "emulator-5558",
          proc: null,
          ownsProcess: avd !== "Attached",
          stop: async () => {
            stops.push(avd);
          },
        }),
        stopEmulator: async (serial) => {
          killed.push(serial);
        },
      },
    );
    for (const avd of ["Owned", "Attached", "Stopped_Via_Api"]) {
      const startResponse = await response(
        h.request("/api/avds/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ avd, select: false }),
        }),
      );
      expect(startResponse.status).toBe(200);
    }
    // /api/avds/stop on a launch this server owns goes through the launch.
    const stopResponse = await response(
      h.request("/api/avds/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serial: "emulator-5558" }),
      }),
    );
    expect(stopResponse.status).toBe(200);
    expect(stops).toEqual(["Stopped_Via_Api"]);

    await h.started.stop();
    expect(stops).toEqual(["Stopped_Via_Api", "Owned"]);
    expect(killed).toEqual([]);
  });

  test("forgets launched emulators that exit on their own", async () => {
    const processes = new Map<string, EventEmitter>();
    const launchStops: string[] = [];
    const killed: string[] = [];
    const h = await createHarness(
      { serials: ["A"] },
      {
        startEmulator: async ({ avd }) => {
          const proc = new EventEmitter();
          processes.set(avd, proc);
          return {
            serial: avd === "First" ? "emulator-5556" : "emulator-5558",
            proc: proc as unknown as EmulatorLaunch["proc"],
            ownsProcess: true,
            stop: async () => {
              launchStops.push(avd);
            },
          };
        },
        stopEmulator: async (serial) => {
          killed.push(serial);
        },
      },
    );
    for (const avd of ["First", "Second"]) {
      const startResponse = await response(
        h.request("/api/avds/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ avd, select: false }),
        }),
      );
      expect(startResponse.status).toBe(200);
    }

    // The user closes both; another AVD may take either port next.
    processes.get("First")?.emit("exit", 0, null);
    processes.get("Second")?.emit("exit", 0, null);

    // An explicit stop by serial reaches whatever runs there now, not the
    // launch that already exited.
    const stopResponse = await response(
      h.request("/api/avds/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serial: "emulator-5556" }),
      }),
    );
    expect(stopResponse.status).toBe(200);
    expect(killed).toEqual(["emulator-5556"]);

    await h.started.stop();
    expect(launchStops).toEqual([]);
  });

  test("server stop aborts an emulator that is still booting", async () => {
    const booting = deferred<void>();
    const events: string[] = [];
    let bootSignal: AbortSignal | undefined;
    const h = await createHarness(
      { serials: ["A"] },
      {
        startEmulator: async ({ signal }) => {
          bootSignal = signal;
          booting.resolve();
          return await new Promise<never>((_, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                // Like the real launch: stop the child, then reject.
                setTimeout(() => {
                  events.push("boot cleaned up");
                  reject(signal.reason);
                }, 10);
              },
              { once: true },
            );
          });
        },
      },
    );
    const start = response(
      h.request("/api/avds/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avd: "Slow_AVD" }),
      }),
    );
    await booting.promise;
    expect(bootSignal?.aborted).toBe(false);
    await h.started.stop();
    events.push("server stopped");
    expect(bootSignal?.aborted).toBe(true);
    expect(events).toEqual(["boot cleaned up", "server stopped"]);
    expect((await start).status).toBeGreaterThanOrEqual(400);
  });

  test("the device grid lists adb devices once per request and resolves AVDs from that list", async () => {
    const devices = [
      { serial: "emulator-5554", state: "device" },
      { serial: "emulator-5556", state: "offline" },
    ];
    let listings = 0;
    const snapshots: unknown[] = [];
    const h = await createHarness(
      { serial: "emulator-5554" },
      {
        listDevices: async () => {
          listings++;
          return devices;
        },
        listRunningAvds: async (snapshot) => {
          snapshots.push(snapshot);
          return [
            { serial: "emulator-5554", avd: "Pixel_A", state: "device" },
            { serial: "emulator-5556", avd: "Pixel_B", state: "offline" },
          ];
        },
        listAvds: async () => ["Pixel_A", "Pixel_B", "Pixel_C"],
      },
    );
    try {
      listings = 0;
      const gridResponse = await response(h.request("/api/device-grid"));
      expect(gridResponse.status).toBe(200);
      const grid = parseDeviceGridResponse(await gridResponse.json());
      expect(listings).toBe(1);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toBe(devices);
      expect(
        grid.devices.map((row) => [row.id, row.kind, row.avd, row.state, row.current, row.canSelect, row.canStart, row.canStop]),
      ).toEqual([
        ["emulator-5554", "emulator", "Pixel_A", "device", true, true, false, true],
        // A running but offline AVD stays one row, not a second "stopped" one.
        ["emulator-5556", "emulator", "Pixel_B", "offline", false, false, false, true],
        ["avd:Pixel_C", "avd", "Pixel_C", "stopped", false, false, true, false],
      ]);

      await h.request("/api/device-grid");
      expect(listings).toBe(2);
      expect(snapshots).toHaveLength(2);
    } finally {
      await h.started.stop();
    }
  });
});
