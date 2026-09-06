import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ScrcpyStreamError } from "../src/scrcpy.ts";
import { startServer } from "../src/server.ts";
import { parseFramePacket } from "../src/shared/frame-meta.ts";

import {
  createHarness,
  fakeScrcpy,
  fakeWebSocket,
  response,
  waitFor,
  type FakeWebSocket,
} from "./helpers/server-harness.ts";

describe("server request gates", () => {
  test("accepts bearer, cookie, and query credentials with explicit precedence", async () => {
    const harness = await createHarness({ token: "test-secret" });

    const missing = await response(harness.request("/api"));
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe("Bearer");
    expect(await missing.json()).toEqual({ ok: false, error: "unauthorized" });

    const wrongLength = await response(
      harness.request("/api", {
        headers: { authorization: "Bearer short" },
      }),
    );
    expect(wrongLength.status).toBe(401);

    const bearer = await response(
      harness.request("/api", {
        headers: { authorization: "Bearer   test-secret  " },
      }),
    );
    expect(bearer.status).toBe(200);

    const cookie = await response(
      harness.request("/api", {
        headers: {
          cookie: "flag; =ignored; theme=dark; semu_session=test-secret",
        },
      }),
    );
    expect(cookie.status).toBe(200);

    const query = await response(harness.request("/api?token=test-secret"));
    expect(query.status).toBe(200);

    const invalidBearerWins = await response(
      harness.request("/api?token=test-secret", {
        headers: {
          authorization: "Bearer wrong-secret",
          cookie: "semu_session=test-secret",
        },
      }),
    );
    expect(invalidBearerWins.status).toBe(401);
    expect(await invalidBearerWins.text()).not.toContain("test-secret");
  });

  test("exchanges an HTML navigation token for a scoped cookie and clean URL", async () => {
    const harness = await createHarness({ token: "test-secret" });
    const bootstrap = await response(
      harness.request("/?token=test-secret&view=grid", {
        headers: { accept: "text/html,application/xhtml+xml" },
      }),
    );

    expect(bootstrap.status).toBe(303);
    expect(bootstrap.headers.get("location")).toBe("/?view=grid");
    expect(bootstrap.headers.get("set-cookie")).toBe(
      "semu_session=test-secret; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400",
    );

    const api = await response(
      harness.request("/api?token=test-secret", {
        headers: { accept: "application/json" },
      }),
    );
    expect(api.status).toBe(200);
    expect(api.headers.get("set-cookie")).toBeNull();
    expect(await api.json()).toMatchObject({
      serial: "emulator-5554",
      status: "streaming",
    });
  });

  test("rejects cross-origin mutations and upgrades before routing", async () => {
    const harness = await createHarness();

    const crossOriginPost = await response(
      harness.request("/api/tap", {
        method: "POST",
        headers: { origin: "https://attacker.example" },
        body: "{",
      }),
    );
    expect(crossOriginPost.status).toBe(403);
    expect(await crossOriginPost.json()).toEqual({
      ok: false,
      error: "forbidden origin",
    });

    const malformedOrigin = await response(
      harness.request("/api/tap", {
        method: "POST",
        headers: { origin: "not a valid origin" },
        body: "{",
      }),
    );
    expect(malformedOrigin.status).toBe(403);

    const sameOriginPost = await response(
      harness.request("/api/tap", {
        method: "POST",
        headers: { origin: "http://127.0.0.1:33040" },
        body: "{",
      }),
    );
    expect(sameOriginPost.status).toBe(400);
    expect(await sameOriginPost.json()).toMatchObject({
      ok: false,
      code: "invalid-json",
    });

    const crossOriginRead = await response(
      harness.request("/api", {
        headers: { origin: "https://reader.example" },
      }),
    );
    expect(crossOriginRead.status).toBe(200);

    const crossOriginUpgrade = await response(
      harness.request("/ws", {
        headers: { origin: "https://attacker.example" },
      }),
    );
    expect(crossOriginUpgrade.status).toBe(403);
    expect(harness.server.upgrades).toHaveLength(0);
  });
});

describe("server HTTP and WebSocket boundaries", () => {
  test("enforces route-specific methods across the public HTTP surface", async () => {
    const harness = await createHarness();
    const mismatches: Array<[method: string, path: string]> = [
      ["POST", "/api/devices"],
      ["POST", "/api/device-grid"],
      ["GET", "/api/devices/select"],
      ["GET", "/api/avds/start"],
      ["GET", "/api/avds/stop"],
      ["PATCH", "/api/orientation"],
      ["PATCH", "/api/night-mode"],
      ["PATCH", "/api/font-scale"],
      ["PATCH", "/api/network"],
      ["POST", "/api/logcat"],
      ["PATCH", "/api/screenshot"],
      ["POST", "/api/foreground"],
      ["POST", "/api/accessibility"],
      ["GET", "/api/accessibility/tap"],
      ["GET", "/api/tap"],
      ["GET", "/api/swipe"],
      ["GET", "/api/text"],
      ["GET", "/api/key"],
      ["PATCH", "/api/session"],
      ["POST", "/api/session/export"],
      ["GET", "/api/session/replay"],
      ["GET", "/api/session/replay/stop"],
      ["GET", "/api/apps/install"],
      ["GET", "/api/files/import"],
      ["GET", "/api/apps/launch"],
      ["GET", "/api/apps/clear"],
      ["GET", "/api/apps/force-stop"],
      ["GET", "/api/apps/grant"],
      ["PATCH", "/api/location"],
      ["PATCH", "/api/route"],
      ["GET", "/api/route/control"],
    ];

    for (const [method, path] of mismatches) {
      const result = await response(harness.request(path, { method }));
      expect(result.status, `${method} ${path}`).toBe(405);
      expect(await result.json(), `${method} ${path}`).toMatchObject({
        ok: false,
        error: { code: "method_not_allowed" },
      });
      expect(result.headers.get("allow")).not.toBeNull();
    }
  });

  test("routes local state reads without invoking Android dependencies", async () => {
    const harness = await createHarness();

    const location = await response(harness.request("/api/location"));
    expect(await location.json()).toEqual({
      generation: 0,
      serial: "emulator-5554",
      emulator: true,
      location: null,
    });

    const route = await response(harness.request("/api/route"));
    expect(await route.json()).toMatchObject({ status: "idle" });

    const sessionPage = await response(harness.request("/api/session"));
    expect(await sessionPage.json()).toMatchObject({
      events: [],
      session: { eventCount: 0 },
    });

    const sessionExport = await response(
      harness.request("/api/session/export"),
    );
    expect(await sessionExport.json()).toMatchObject({ events: [] });

    const unknownApi = await response(harness.request("/api/not-registered"));
    expect(unknownApi.status).toBe(404);
    expect(await unknownApi.json()).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  test("merges physical devices, running emulators, and stopped AVDs", async () => {
    const harness = await createHarness(
      {},
      {
        listDevices: async () => [
          { serial: "emulator-5554", state: "device" },
          { serial: "usb-device", state: "unauthorized" },
        ],
        listRunningAvds: async () => [
          {
            serial: "emulator-5554",
            avd: "Pixel_Running",
            state: "device",
          },
        ],
        listAvds: async () => ["Pixel_Running", "Pixel_Stopped"],
      },
    );

    const devices = await response(harness.request("/api/devices"));
    expect(await devices.json()).toMatchObject({
      ok: true,
      currentSerial: "emulator-5554",
      devices: [
        { serial: "emulator-5554", current: true },
        { serial: "usb-device", current: false },
      ],
    });

    const grid = await response(harness.request("/api/device-grid"));
    expect(await grid.json()).toMatchObject({
      currentSerial: "emulator-5554",
      sessionStatus: "streaming",
      devices: [
        {
          id: "emulator-5554",
          kind: "emulator",
          avd: "Pixel_Running",
          current: true,
          canSelect: true,
          canStop: true,
        },
        {
          id: "usb-device",
          kind: "physical",
          current: false,
          canSelect: false,
          canStop: false,
        },
        {
          id: "avd:Pixel_Stopped",
          kind: "avd",
          state: "stopped",
          canStart: true,
          canStop: false,
        },
      ],
    });
  });

  test("returns bounded 400 responses for invalid public API payloads", async () => {
    const harness = await createHarness();
    const invalidRequests: Array<[path: string, payload: unknown]> = [
      ["/api/devices/select", {}],
      ["/api/avds/start", {}],
      ["/api/avds/stop", {}],
      ["/api/orientation", { orientation: "upside-down" }],
      ["/api/night-mode", { mode: "midnight" }],
      ["/api/font-scale", { scale: 3 }],
      ["/api/network", { enabled: "yes" }],
      ["/api/accessibility/tap", {}],
      ["/api/tap", {}],
      ["/api/swipe", {}],
      ["/api/text", {}],
      ["/api/key", {}],
      ["/api/apps/launch", null],
      ["/api/apps/clear", null],
      ["/api/apps/force-stop", null],
      ["/api/apps/grant", null],
      ["/api/location", {}],
      ["/api/route", {}],
      ["/api/route/control", { action: "rewind" }],
      ["/api/session/replay", { multiplier: "fast" }],
    ];

    for (const [path, payload] of invalidRequests) {
      const result = await response(
        harness.request(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }),
      );
      expect(result.status, path).toBe(400);
      expect(await result.json(), path).toMatchObject({ ok: false });
    }
  });

  test("serves existing UI files and returns stable missing-file responses", async () => {
    const harness = await createHarness();
    const uiDir = join(import.meta.dir, "..", "dist", "ui");
    const fixtureName = "__server-request-gates-fixture__.txt";
    const fixturePath = join(uiDir, fixtureName);
    await mkdir(uiDir, { recursive: true });
    await writeFile(fixturePath, "static fixture\n", "utf8");
    try {
      const existing = await response(harness.request(`/${fixtureName}`));
      expect(existing.status).toBe(200);
      expect(await existing.text()).toBe("static fixture\n");

      const missing = await response(
        harness.request("/__server-request-gates-missing__.txt"),
      );
      expect(missing.status).toBe(404);
      expect(await missing.text()).toBe("not found");

      const encodedTraversal = await response(
        harness.request("/%2e%2e%2fpackage.json"),
      );
      expect(encodedTraversal.status).toBe(404);
    } finally {
      await rm(fixturePath, { force: true });
    }
  });

  test("reports failed upgrades and carries frame metadata into accepted sockets", async () => {
    const harness = await createHarness();
    harness.server.upgradeResult = false;

    const failed = await response(
      harness.request("/ws", {
        headers: { origin: "http://127.0.0.1:33040" },
      }),
    );
    expect(failed.status).toBe(400);
    expect(await failed.text()).toBe("upgrade failed");

    harness.server.upgradeResult = true;
    const accepted = await harness.request("/ws?frame-meta=1", {
      headers: { origin: "http://127.0.0.1:33040" },
    });
    expect(accepted).toBeUndefined();
    expect(harness.server.upgrades).toHaveLength(2);
    expect(harness.server.upgrades[0]).toMatchObject({
      id: 1,
      frameMeta: false,
    });
    expect(harness.server.upgrades[1]).toMatchObject({
      id: 2,
      frameMeta: true,
    });

    const socket = fakeWebSocket(harness.server.upgrades[1]!);
    harness.handlers.websocket.open(socket);
    expect(
      await response(harness.request("/api")).then((result) => result.json()),
    ).toMatchObject({ clients: 1 });

    harness.handlers.websocket.message(socket, Buffer.from([1, 2, 3]));
    expect(socket.closes).toEqual([]);
    harness.handlers.websocket.message(socket, "x".repeat(16 * 1024 + 1));
    expect(socket.closes).toEqual([
      { code: 1009, reason: "message too large" },
    ]);

    harness.handlers.websocket.close(socket);
    expect(
      await response(harness.request("/api")).then((result) => result.json()),
    ).toMatchObject({ clients: 0 });
  });

  test("broadcasts session changes, cached config, and framed keyframes", async () => {
    const harness = await createHarness();
    await harness.request("/ws");
    await harness.request("/ws?frame-meta=1");
    const rawSocket = fakeWebSocket(harness.server.upgrades[0]!);
    const framedSocket = fakeWebSocket(harness.server.upgrades[1]!);
    harness.handlers.websocket.open(rawSocket);
    harness.handlers.websocket.open(framedSocket);

    harness.session.pushFrame({
      type: "session",
      width: 1080,
      height: 1920,
      clientResized: true,
    });
    await waitFor(() => rawSocket.sent.length === 1);
    expect(rawSocket.sent[0]).toEqual({
      type: "video-session",
      size: { width: 1080, height: 1920 },
    });
    expect(framedSocket.sent[0]).toEqual(rawSocket.sent[0]);

    const config = Buffer.from([0, 0, 0, 1, 0x67, 0x64]);
    const keyFrame = Buffer.from([0, 0, 0, 1, 0x65, 0x01]);
    harness.session.pushFrame({
      type: "frame",
      data: config,
      pts: 9_000n,
      isConfig: true,
      isKey: false,
    });
    harness.session.pushFrame({
      type: "frame",
      data: keyFrame,
      pts: 9_001n,
      isConfig: false,
      isKey: true,
    });
    await waitFor(() => rawSocket.sent.some((value) => Buffer.isBuffer(value)));

    const rawPacket = rawSocket.sent.find((value) =>
      Buffer.isBuffer(value),
    ) as Buffer;
    expect(rawPacket).toEqual(Buffer.concat([config, keyFrame]));
    const framedPacket = framedSocket.sent.find((value) =>
      Buffer.isBuffer(value),
    ) as Buffer;
    const parsed = parseFramePacket(framedPacket);
    expect(parsed).toMatchObject({ isKey: true, timestamp: 9_001 });
    expect(Buffer.from(parsed.data)).toEqual(Buffer.concat([config, keyFrame]));

    const health = await response(harness.request("/health"));
    expect(await health.json()).toMatchObject({
      size: { width: 1080, height: 1920 },
      frames: 1,
      configPackets: 1,
    });
  });

  test("isolates slow and failed WebSocket clients during frame delivery", async () => {
    const harness = await createHarness();
    const socketOptions = [
      { bufferedAmount: 16 * 1024 * 1024 + 1 },
      { bufferedAmount: 512 * 1024 + 1 },
      { throwOnSend: true },
      { sendResult: -1 },
      { sendResult: 0 },
      {},
    ];
    const sockets: FakeWebSocket[] = [];
    for (const options of socketOptions) {
      await harness.request("/ws");
      const socket = fakeWebSocket(harness.server.upgrades.at(-1)!, options);
      sockets.push(socket);
      harness.handlers.websocket.open(socket);
    }

    harness.session.pushFrame({
      type: "frame",
      data: Buffer.from([0, 0, 0, 1, 0x41]),
      pts: 10n,
      isConfig: false,
      isKey: false,
    });
    await waitFor(() => sockets[0]!.closes.length === 1);
    expect(sockets[0]!.closes[0]?.code).toBe(1013);
    harness.session.pushFrame({
      type: "frame",
      data: Buffer.from([0, 0, 0, 1, 0x65]),
      pts: 11n,
      isConfig: false,
      isKey: true,
    });
    await waitFor(() => sockets[5]!.sent.length === 1);

    expect(sockets[0]!.closes).toEqual([
      { code: 1013, reason: "client too slow" },
    ]);
    expect(sockets[2]!.closes).toEqual([
      { code: 1011, reason: "frame send failed" },
    ]);
    expect(sockets[5]!.sent).toHaveLength(1);

    const health = await response(harness.request("/health"));
    expect(await health.json()).toMatchObject({
      clients: 3,
      frames: 2,
      droppedFrames: 7,
      backpressureEvents: 1,
      keyFrameRecovery: { awaitingClients: 2 },
    });
  });

  test("returns terminal health instead of upgrading a stopped stream", async () => {
    const harness = await createHarness();
    harness.session.endFrames();
    await waitFor(
      async () => (await response(harness.request("/health"))).status === 503,
    );

    const unavailable = await response(
      harness.request("/ws", {
        headers: { origin: "http://127.0.0.1:33040" },
      }),
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      ok: false,
      status: "stopped",
      lastError: "scrcpy video stream ended",
    });
    expect(harness.server.upgrades).toHaveLength(0);
  });
});

describe("server shutdown and errors", () => {
  test("makes stop idempotent and closes active connections exactly once", async () => {
    const harness = await createHarness();
    const first = harness.started.stop();
    const second = harness.started.stop();

    expect(second).toBe(first);
    await first;
    expect(harness.server.stopArguments).toEqual([true]);
    expect(harness.session.closeCalls).toBe(1);
    expect(harness.started.session).toBeNull();
    expect(harness.started.getSession()).toBeNull();
  });

  test("rolls back scrcpy when session construction fails before binding", async () => {
    const session = fakeScrcpy();
    let serveCalls = 0;

    await expect(
      startServer(
        { serial: session.serial, port: 33_041 },
        {
          openScrcpy: async () => session,
          createInputQueue: () => {
            throw new Error("input queue construction failed");
          },
          serve: (() => {
            serveCalls += 1;
            throw new Error("serve should not be called");
          }) as unknown as typeof Bun.serve,
        },
      ),
    ).rejects.toThrow("input queue construction failed");
    expect(session.closeCalls).toBe(1);
    expect(serveCalls).toBe(0);
  });

  test("surfaces structured scrcpy stream failures through health", async () => {
    const harness = await createHarness();
    harness.session.failFrames(
      new ScrcpyStreamError("truncated-payload", "video payload ended early", {
        expected: 128,
        received: 64,
      }),
    );
    await waitFor(
      async () => (await response(harness.request("/health"))).status === 503,
    );

    const health = await response(harness.request("/health"));
    expect(await health.json()).toMatchObject({
      ok: false,
      status: "error",
      lastError: "video payload ended early",
      lastErrorCode: "truncated-payload",
      lastErrorMeta: { expected: 128, received: 64 },
    });
  });
});
