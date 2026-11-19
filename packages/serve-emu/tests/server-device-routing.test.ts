import { describe, expect, test } from "bun:test";
import { isServicePath, splitDevicePath } from "../src/server/device-path.ts";
import type { DeviceContext } from "../src/server/types.ts";
import {
  createHarness,
  fakeScrcpy,
  fakeWebSocket,
  response,
  waitFor,
  type FakeScrcpy,
} from "./helpers/server-harness.ts";

/** Fresh fake scrcpy per open, so a prefixed stream never shares one. */
async function multiDeviceHarness(
  options: Parameters<typeof createHarness>[0] = {},
  overrides: Parameters<typeof createHarness>[1] = {},
) {
  const opened: FakeScrcpy[] = [];
  const h = await createHarness(
    { serials: ["A", "B", "C"], ...options },
    {
      openScrcpy: async (serial) => {
        const session = fakeScrcpy(serial);
        opened.push(session);
        return session;
      },
      ...overrides,
    },
  );
  const opensOf = (serial: string) => opened.filter((s) => s.serial === serial);
  return { ...h, opened, opensOf };
}

async function json(value: Promise<Response | undefined>) {
  const res = await response(value);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe("device path prefix", () => {
  test("splits /d/<serial>/ and decodes the serial", () => {
    expect(splitDevicePath("/health")).toEqual({ serial: null, path: "/health" });
    expect(splitDevicePath("/d/emulator-5556/api/tap")).toEqual({
      serial: "emulator-5556",
      path: "/api/tap",
    });
    expect(splitDevicePath("/d/10.0.0.2%3A5555/ws")).toEqual({
      serial: "10.0.0.2:5555",
      path: "/ws",
    });
    expect(splitDevicePath("/d/A")).toEqual({ serial: "A", path: "/" });
    expect(splitDevicePath("/d//health")).toBeNull();
    expect(splitDevicePath("/d/%E0/health")).toBeNull();
    expect(splitDevicePath("/d/a%2Fb/health")).toBeNull();
  });

  test("treats prefixed /api, /health, and /ws as service paths", () => {
    for (const path of ["/d/A/api", "/d/A/api/tap", "/d/A/health", "/d/A/ws", "/api/x"]) {
      expect(isServicePath(path)).toBe(true);
    }
    for (const path of ["/d/A/", "/d/A/index.html", "/apix", "/"]) {
      expect(isServicePath(path)).toBe(false);
    }
  });
});

describe("startServer multi-device routing", () => {
  test("opens a prefixed device on first use and leaves the selected one alone", async () => {
    const h = await multiDeviceHarness();
    const pinned = await json(h.request("/d/B/health"));
    expect(pinned.status).toBe(200);
    expect(pinned.body.serial).toBe("B");
    expect(h.opensOf("B")).toHaveLength(1);

    const again = await json(h.request("/d/B/api/devices"));
    expect(again.body.currentSerial).toBe("B");
    expect(h.opensOf("B")).toHaveLength(1);

    const selected = await json(h.request("/health"));
    expect(selected.body.serial).toBe("A");
    // The selected device's own prefix reaches the selected stream.
    expect((await json(h.request("/d/A/health"))).body.generation).toBe(
      selected.body.generation,
    );
    expect(h.opensOf("A")).toHaveLength(1);
    expect(pinned.body.generation).not.toBe(selected.body.generation);
  });

  test("binds a prefixed WebSocket to that device", async () => {
    const h = await multiDeviceHarness();
    expect(await h.request("/d/B/ws?frame-meta=1")).toBeUndefined();
    const data = h.server.upgrades.at(-1)!;
    const context = data.context as DeviceContext;
    expect(context.serial).toBe("B");
    expect(data.frameMeta).toBe(true);
    const socket = fakeWebSocket(data);
    h.handlers.websocket.open(socket);
    expect(context.clients.size).toBe(1);
    h.handlers.websocket.close(socket);
    expect(context.clients.size).toBe(0);
  });

  test("rejects unknown serials, malformed prefixes, and prefixed UI files", async () => {
    const h = await multiDeviceHarness();
    const unknown = await json(h.request("/d/Z/health"));
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toMatchObject({ code: "not_found", reason: "unknown-device" });
    expect((await response(h.request("/d/%E0/health"))).status).toBe(404);
    expect((await response(h.request("/d/B/index.html"))).status).toBe(404);
    expect(h.opensOf("B")).toHaveLength(0);
  });

  test("caps open devices at maxDevices", async () => {
    const h = await multiDeviceHarness({ maxDevices: 2 });
    expect((await response(h.request("/d/B/health"))).status).toBe(200);
    const limited = await json(h.request("/d/C/health"));
    expect(limited.status).toBe(503);
    expect(limited.body.error).toMatchObject({
      code: "service_unavailable",
      reason: "device-limit",
    });
    expect(h.opensOf("C")).toHaveLength(0);
  });

  test("rejects a non-positive maxDevices", async () => {
    await expect(multiDeviceHarness({ maxDevices: 0 })).rejects.toThrow(
      "maxDevices must be a positive integer",
    );
  });

  test("reports a failed open as 503 and retries on the next request", async () => {
    let fail = true;
    const h = await createHarness(
      { serials: ["A", "B"] },
      {
        openScrcpy: async (serial) => {
          if (serial === "B" && fail) throw new Error("scrcpy exploded");
          return fakeScrcpy(serial);
        },
      },
    );
    const failed = await json(h.request("/d/B/health"));
    expect(failed.status).toBe(503);
    expect(failed.body.error).toMatchObject({ reason: "device-open-failed" });
    expect(JSON.stringify(failed.body)).not.toContain("exploded");
    fail = false;
    expect((await response(h.request("/d/B/health"))).status).toBe(200);
  });

  test("a prefixed stream cannot switch devices", async () => {
    const h = await multiDeviceHarness();
    const res = await json(
      h.request("/d/B/api/devices/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serial: "C" }),
      }),
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: "conflict", reason: "device-pinned" });
    expect(h.opensOf("C")).toHaveLength(0);
  });

  test("a prefixed stream refuses to boot an emulator it would select", async () => {
    const launched: string[] = [];
    const h = await multiDeviceHarness(
      {},
      {
        startEmulator: async (opts) => {
          launched.push(opts.avd);
          throw new Error("must not launch");
        },
      },
    );
    const res = await json(
      h.request("/d/B/api/avds/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avd: "pixel" }),
      }),
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ reason: "device-pinned" });
    expect(launched).toEqual([]);
  });

  test("stopping an emulator through another prefix stops its streams", async () => {
    const killed: string[] = [];
    const h = await multiDeviceHarness(
      { serials: ["emulator-5554", "emulator-5556", "emulator-5558"] },
      {
        stopEmulator: async (serial) => {
          killed.push(serial);
        },
      },
    );
    const stopVia = (prefix: string, serial: string) =>
      response(
        h.request(`${prefix}/api/avds/stop`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ serial }),
        }),
      );
    await response(h.request("/d/emulator-5558/health"));
    expect((await stopVia("/d/emulator-5556", "emulator-5558")).status).toBe(200);
    expect(h.opensOf("emulator-5558")[0]!.closeCalls).toBe(1);

    expect((await stopVia("/d/emulator-5556", "emulator-5554")).status).toBe(200);
    expect(h.started.deviceSerial).toBeNull();
    expect(killed).toEqual(["emulator-5558", "emulator-5554"]);
  });

  test("selecting a prefixed device closes its prefixed stream", async () => {
    const h = await multiDeviceHarness();
    await response(h.request("/d/B/health"));
    const select = await response(
      h.request("/api/devices/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serial: "B" }),
      }),
    );
    expect(select.status).toBe(200);
    const [pinnedB, selectedB] = h.opensOf("B");
    await waitFor(() => pinnedB!.closeCalls === 1);
    expect(selectedB!.closeCalls).toBe(0);
    expect(h.started.session).toBe(selectedB!);
    // The prefix now reaches the selected stream instead of opening another.
    expect((await json(h.request("/d/B/health"))).body.serial).toBe("B");
    expect(h.opensOf("B")).toHaveLength(2);
  });

  test("closes a prefixed stream once nothing uses it", async () => {
    const h = await multiDeviceHarness({ idleDeviceMs: 20 });
    expect(await h.request("/d/B/ws")).toBeUndefined();
    const data = h.server.upgrades.at(-1)!;
    const socket = fakeWebSocket(data);
    h.handlers.websocket.open(socket);
    const [pinnedB] = h.opensOf("B");
    await Bun.sleep(80);
    expect(pinnedB!.closeCalls).toBe(0);

    h.handlers.websocket.close(socket);
    await waitFor(() => pinnedB!.closeCalls === 1);
    // The next request opens a fresh stream.
    expect((await response(h.request("/d/B/health"))).status).toBe(200);
    expect(h.opensOf("B")).toHaveLength(2);
  });

  test("stop closes prefixed streams", async () => {
    const h = await multiDeviceHarness();
    await response(h.request("/d/B/health"));
    await response(h.request("/d/C/health"));
    await h.started.stop();
    expect(h.opened.map((s) => s.closeCalls)).toEqual([1, 1, 1]);
    const stopped = await json(h.request("/d/C/health"));
    expect(stopped.status).toBe(503);
  });

  test("applies the cross-site and Origin gates under the prefix", async () => {
    const h = await multiDeviceHarness();
    const crossSite = await response(
      h.request("/d/B/health", {
        headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" },
      }),
    );
    expect(crossSite.status).toBe(403);

    const tokened = await multiDeviceHarness({ token: "secret", port: 33_041 });
    const badOrigin = await response(
      tokened.request("/d/B/ws", {
        headers: { authorization: "Bearer secret", origin: "http://evil.example" },
      }),
    );
    expect(badOrigin.status).toBe(403);
    expect(tokened.opensOf("B")).toHaveLength(0);
  });
});
