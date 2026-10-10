import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidTokenError, startupUrl } from "../src/access-policy.ts";
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

  test("a token with every allowed character class round-trips through URL, cookie, and bearer", async () => {
    const token = "AZaz09._~-";
    const harness = await createHarness({ token });
    const printed = new URL(startupUrl("http://127.0.0.1:3300", token));
    const bootstrap = await response(
      harness.request(`${printed.pathname}${printed.search}`, {
        headers: { accept: "text/html" },
      }),
    );
    expect(bootstrap.status).toBe(303);
    // What a browser stores: the cookie value up to the first ';'.
    const stored = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
    expect(stored).toBe(`semu_session=${token}`);
    expect((await response(harness.request("/api", { headers: { cookie: stored } }))).status).toBe(200);
    expect(
      (await response(harness.request("/api", { headers: { authorization: `Bearer ${token}` } }))).status,
    ).toBe(200);
  });

  test("refuses to start with a token the cookie or URL would corrupt", async () => {
    for (const token of ["abc;def", "a+b", "a b"]) {
      await expect(
        startServer({ serial: "emulator-5554", port: 0, token }, { openScrcpy: async () => fakeScrcpy() }),
      ).rejects.toThrow(InvalidTokenError);
    }
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

  test("rejects DNS-rebound host names before routing when auth is off", async () => {
    const harness = await createHarness();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      // A rebound page is same-origin with itself, so Origin matches Host.
      const rebound = {
        host: "evil.example:33040",
        origin: "http://evil.example:33040",
      };
      const mutation = await response(
        harness.request("/api/tap", {
          method: "POST",
          headers: rebound,
          body: "{",
        }),
      );
      expect(mutation.status).toBe(403);
      expect(await mutation.json()).toEqual({
        ok: false,
        error: "forbidden host",
      });
      for (const path of ["/api", "/health", "/", "/ws"]) {
        const read = await response(
          harness.request(path, { headers: rebound }),
        );
        expect(read.status).toBe(403);
      }
      expect(harness.server.upgrades).toHaveLength(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("evil.example:33040");
    } finally {
      warn.mockRestore();
    }

    // The Vite dev proxy keeps its own Host and Origin (changeOrigin: false).
    const viteProxy = await response(
      harness.request("/api/tap", {
        method: "POST",
        headers: { host: "localhost:5173", origin: "http://localhost:5173" },
        body: "{",
      }),
    );
    expect(viteProxy.status).toBe(400);
    expect(await viteProxy.json()).toMatchObject({ code: "invalid-json" });

    for (const host of ["localhost:33040", "[::1]:33040", "192.168.1.20:33040"]) {
      const read = await response(harness.request("/api", { headers: { host } }));
      expect(read.status).toBe(200);
    }
  });

  test("serves configured host names and leaves rebinding to the token when set", async () => {
    const configured = await createHarness({
      host: "0.0.0.0",
      allowedHosts: ["DevBox.lan"],
    });
    const named = await response(
      configured.request("/api", { headers: { host: "devbox.lan:33040" } }),
    );
    expect(named.status).toBe(200);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const other = await response(
        configured.request("/api", { headers: { host: "other.lan:33040" } }),
      );
      expect(other.status).toBe(403);
    } finally {
      warn.mockRestore();
    }

    const authenticated = await createHarness({ token: "test-secret" });
    const withToken = await response(
      authenticated.request("/api", {
        headers: {
          host: "serve-emu.example:443",
          authorization: "Bearer test-secret",
        },
      }),
    );
    expect(withToken.status).toBe(200);
    const withoutToken = await response(
      authenticated.request("/api", {
        headers: { host: "serve-emu.example:443" },
      }),
    );
    expect(withoutToken.status).toBe(401);
  });

  test("rejects malformed allowed host names at startup", async () => {
    await expect(
      createHarness({ allowedHosts: ["devbox.lan/admin"] }),
    ).rejects.toThrow('invalid allowed host "devbox.lan/admin"');
  });

  test("rejects cross-site subresource requests and API navigations, but not UI navigations", async () => {
    const harness = await createHarness();
    const image = await response(
      harness.request("/api", {
        headers: {
          "sec-fetch-site": "cross-site",
          "sec-fetch-mode": "no-cors",
          "sec-fetch-dest": "image",
        },
      }),
    );
    expect(image.status).toBe(403);
    expect(await image.json()).toEqual({
      ok: false,
      error: "forbidden cross-site request",
    });

    const navigationHeaders = {
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "iframe",
    };
    const apiNavigation = await response(
      harness.request("/api", { headers: navigationHeaders }),
    );
    expect(apiNavigation.status).toBe(403);
    expect(await apiNavigation.json()).toEqual({
      ok: false,
      error: "forbidden cross-site request",
    });

    const uiNavigation = await response(
      harness.request("/", { headers: navigationHeaders }),
    );
    expect(uiNavigation.status).not.toBe(403);
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
    // A private UI directory: concurrent runs and `vite build --emptyOutDir`
    // must not see (or remove) this fixture, and it must never reach the
    // published dist/ui.
    const base = await mkdtemp(join(tmpdir(), "serve-emu-ui-"));
    try {
      const uiDir = join(base, "ui");
      await mkdir(uiDir);
      // A file next to the UI directory that traversal must never reach.
      await writeFile(join(base, "secret.txt"), "outside the UI\n", "utf8");
      const harness = await createHarness({}, { uiDir });
      const fixtureName = "__server-request-gates-fixture__.txt";
      await writeFile(join(uiDir, fixtureName), "static fixture\n", "utf8");
      await writeFile(join(uiDir, "index.html"), "<!doctype html>fixture ui", "utf8");

      const index = await response(harness.request("/"));
      expect(index.status).toBe(200);
      expect(await index.text()).toBe("<!doctype html>fixture ui");

      const existing = await response(harness.request(`/${fixtureName}`));
      expect(existing.status).toBe(200);
      expect(await existing.text()).toBe("static fixture\n");

      const missing = await response(
        harness.request("/__server-request-gates-missing__.txt"),
      );
      expect(missing.status).toBe(404);
      expect(await missing.text()).toBe("not found");

      // URL parsing already folds `/../` and `/%2e%2e/` into `/secret.txt`,
      // so those only prove the file stays outside the UI directory. The
      // encoded-slash form reaches the handler as-is and guards against a
      // future change that decodes the path before the `..` check.
      for (const traversal of ["/%2e%2e%2fsecret.txt", "/../secret.txt", "/%2e%2e/secret.txt"]) {
        const escaped = await response(harness.request(traversal));
        expect(escaped.status, traversal).toBe(404);
        expect(await escaped.text(), traversal).not.toContain("outside the UI");
      }
    } finally {
      await rm(base, { recursive: true, force: true });
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
