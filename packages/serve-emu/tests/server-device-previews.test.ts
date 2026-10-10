import { describe, expect, test } from "bun:test";
import {
  createHarness,
  fakeScrcpy,
  fakeWebSocket,
  response,
  waitFor,
  type Harness,
} from "./helpers/server-harness.ts";

async function openPreview(harness: Harness, serial: string) {
  expect(await harness.request(`/ws?frame-meta=1&serial=${encodeURIComponent(serial)}`)).toBeUndefined();
  const socket = fakeWebSocket(harness.server.upgrades.at(-1)!);
  harness.handlers.websocket.open(socket);
  return socket;
}

function keyFrame(value: number) {
  return {
    type: "frame" as const,
    data: Buffer.from([0, 0, 0, 1, 0x65, value]),
    pts: 1n,
    isConfig: false,
    isKey: true,
  };
}

describe("independent device previews", () => {
  test("shares preview streams across tabs, isolates devices, and survives active switches", async () => {
    const opened: ReturnType<typeof fakeScrcpy>[] = [];
    const harness = await createHarness({ serial: "A" }, {
      listDevices: async () => [{ serial: "A", state: "device" }, { serial: "B", state: "device" }],
      openScrcpy: async (serial) => {
        const session = fakeScrcpy(serial);
        opened.push(session);
        return session;
      },
    });
    await Promise.all([
      harness.request("/ws?serial=A"), harness.request("/ws?serial=B"), harness.request("/ws?serial=B"),
    ]);
    expect(opened.map((session) => session.serial)).toEqual(["A", "A", "B"]);
    const sockets = harness.server.upgrades.map((data) => fakeWebSocket(data));
    for (const socket of sockets) harness.handlers.websocket.open(socket);
    for (const socket of sockets) harness.handlers.websocket.close(socket);
    await waitFor(() => opened[1]!.closeCalls === 1 && opened[2]!.closeCalls === 1);

    const previewA = await openPreview(harness, "A");
    const previewB = await openPreview(harness, "B");
    const anotherB = await openPreview(harness, "B");
    const sessionA = opened[3]!;
    const sessionB = opened[4]!;
    expect(opened).toHaveLength(5);
    expect(previewA.sent[0]).toEqual({ type: "video-session", size: { width: 720, height: 1280 } });
    sessionA.pushFrame(keyFrame(1));
    sessionB.pushFrame(keyFrame(2));
    await waitFor(() => previewA.sent.some(Buffer.isBuffer) && previewB.sent.some(Buffer.isBuffer));
    expect((previewA.sent.find(Buffer.isBuffer) as Buffer).at(-1)).toBe(1);
    expect((previewB.sent.find(Buffer.isBuffer) as Buffer).at(-1)).toBe(2);
    expect(anotherB.sent.find(Buffer.isBuffer)).toEqual(previewB.sent.find(Buffer.isBuffer));

    const switched = await response(harness.request("/api/devices/select", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ serial: "B" }),
    }));
    expect(switched.status).toBe(200);
    expect(opened[0]!.closeCalls).toBe(1);
    expect(sessionA.closeCalls).toBe(0);
    expect(sessionB.closeCalls).toBe(0);
    expect(previewA.closes).toEqual([]);
    expect(previewB.closes).toEqual([]);
    sessionA.pushFrame(keyFrame(3));
    await waitFor(() => previewA.sent.filter(Buffer.isBuffer).length === 2);

    harness.handlers.websocket.close(previewB);
    expect(sessionB.closeCalls).toBe(0);
    harness.handlers.websocket.close(anotherB);
    await waitFor(() => sessionB.closeCalls === 1);
    const health = await response(harness.request("/health")).then((result) => result.json());
    expect(health).toMatchObject({ serial: "B", previews: { limit: 16, sessions: [{ serial: "A", clients: 1, frames: 2 }] } });
    await harness.started.stop();
    expect(sessionA.closeCalls).toBe(1);
    expect(previewA.closes.at(-1)?.reason).toBe("server stopping");
  });

  test("permits timing and recovery, but rejects preview input without recording it", async () => {
    const sessions: ReturnType<typeof fakeScrcpy>[] = [];
    const harness = await createHarness({ serial: "A" }, {
      listDevices: async () => [{ serial: "B", state: "device" }],
      openScrcpy: async (serial) => { const session = fakeScrcpy(serial); sessions.push(session); return session; },
    });
    const socket = await openPreview(harness, "B");
    await waitFor(() => sessions[1]!.fakeControlSocket.writes.length === 1);
    harness.handlers.websocket.message(socket, JSON.stringify({ type: "clock-sync", clientTsMs: 42 }));
    expect(socket.sent.at(-1)).toMatchObject({ type: "clock-sync", clientTsMs: 42 });
    harness.handlers.websocket.message(socket, JSON.stringify({ type: "tap", x: 0.5, y: 0.5, requestId: "input" }));
    expect(socket.sent.at(-1)).toEqual({ ok: false, code: "preview_read_only", error: "device previews are read-only", requestId: "input" });
    expect(sessions[1]!.fakeControlSocket.writes).toHaveLength(1);
    harness.handlers.websocket.message(socket, JSON.stringify({ type: "reset-video", requestId: "reset" }));
    await waitFor(() => socket.sent.some((value) => (value as { requestId?: string }).requestId === "reset"));
    expect(socket.sent.at(-1)).toMatchObject({ ok: true, requestId: "reset" });
  });

  test("keeps previews behind auth and Origin checks, validates serials, and cleans failed upgrades", async () => {
    const sessions: ReturnType<typeof fakeScrcpy>[] = [];
    const harness = await createHarness({ serial: "A", token: "secret" }, {
      listDevices: async () => [{ serial: "B", state: "device" }, { serial: "offline", state: "offline" }],
      openScrcpy: async (serial) => { const session = fakeScrcpy(serial); sessions.push(session); return session; },
    });
    expect((await response(harness.request("/ws?serial=B"))).status).toBe(401);
    const headers = { authorization: "Bearer secret" };
    expect((await response(harness.request("/ws?serial=B", { headers: { ...headers, origin: "http://evil.example" } }))).status).toBe(403);
    for (const serial of ["", "a".repeat(257), "%00"]) {
      expect((await response(harness.request(`/ws?serial=${serial}`, { headers }))).status).toBe(400);
    }
    expect((await response(harness.request("/ws?serial=missing", { headers }))).status).toBe(404);
    expect((await response(harness.request("/ws?serial=offline", { headers }))).status).toBe(409);
    expect(sessions).toHaveLength(1);
    harness.server.upgradeResult = false;
    expect((await response(harness.request("/ws?serial=B", { headers }))).status).toBe(400);
    await waitFor(() => sessions[1]!.closeCalls === 1);
    expect(await response(harness.request("/health", { headers })).then((result) => result.json())).toMatchObject({ previews: { sessions: [] } });
  });

  test("bounds the number of simultaneous device streams", async () => {
    const devices = Array.from({ length: 17 }, (_, index) => ({ serial: String(index), state: "device" }));
    let opened = 0;
    const harness = await createHarness({ serial: "A" }, {
      listDevices: async () => devices,
      openScrcpy: async (serial) => { opened++; return fakeScrcpy(serial); },
    });
    const sockets = [];
    for (const device of devices.slice(0, 16)) sockets.push(await openPreview(harness, device.serial));
    expect((await response(harness.request("/ws?serial=16"))).status).toBe(429);
    expect(opened).toBe(17);
    harness.handlers.websocket.close(sockets[0]!);
    await openPreview(harness, "16");
    expect(opened).toBe(18);
  });

  test("cancels pending startup on disconnect and server shutdown", async () => {
    let previewSignal: AbortSignal | undefined;
    const harness = await createHarness({ serial: "A" }, {
      listDevices: async () => [{ serial: "B", state: "device" }],
      openScrcpy: async (serial, signal) => {
        if (serial === "A") return fakeScrcpy(serial);
        previewSignal = signal;
        return await new Promise<never>((_resolve, reject) => {
          signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
        });
      },
    });
    const request = new AbortController();
    const connecting = harness.request("/ws?serial=B", { signal: request.signal });
    await waitFor(() => Boolean(previewSignal));
    request.abort();
    expect((await connecting)?.status).toBe(499);
    expect((previewSignal as AbortSignal | undefined)?.aborted).toBe(true);

    previewSignal = undefined;
    const next = harness.request("/ws?serial=B");
    await waitFor(() => Boolean(previewSignal));
    await harness.started.stop();
    expect((previewSignal as AbortSignal | undefined)?.aborted).toBe(true);
    expect((await next)?.status).toBe(503);
  });

  test("keeps shared startup alive when only one waiting subscriber disconnects", async () => {
    let ready!: (session: ReturnType<typeof fakeScrcpy>) => void;
    let previewSignal: AbortSignal | undefined;
    let starts = 0;
    const harness = await createHarness({ serial: "A" }, {
      listDevices: async () => [{ serial: "B", state: "device" }],
      openScrcpy: async (serial, signal) => {
        if (serial === "A") return fakeScrcpy(serial);
        starts++;
        previewSignal = signal;
        return await new Promise<ReturnType<typeof fakeScrcpy>>((resolve) => { ready = resolve; });
      },
    });
    const abort = new AbortController();
    const first = harness.request("/ws?serial=B", { signal: abort.signal });
    const second = harness.request("/ws?serial=B");
    await waitFor(() => starts === 1);
    abort.abort();
    expect((await first)?.status).toBe(499);
    expect(previewSignal?.aborted).toBe(false);
    const preview = fakeScrcpy("B");
    ready(preview);
    expect(await second).toBeUndefined();
    const socket = fakeWebSocket(harness.server.upgrades.at(-1)!);
    harness.handlers.websocket.open(socket);
    expect(starts).toBe(1);
    harness.handlers.websocket.close(socket);
    await waitFor(() => preview.closeCalls === 1);
  });

  test("contains terminal preview failures and permits reconnecting that device", async () => {
    const sessions: ReturnType<typeof fakeScrcpy>[] = [];
    const harness = await createHarness({ serial: "A" }, {
      listDevices: async () => [{ serial: "B", state: "device" }],
      openScrcpy: async (serial) => { const session = fakeScrcpy(serial); sessions.push(session); return session; },
    });
    const first = await openPreview(harness, "B");
    sessions[1]!.failFrames(new Error("preview encoder failed"));
    await waitFor(() => first.closes.length === 1);
    expect((await response(harness.request("/health"))).status).toBe(200);
    expect(sessions[0]!.closeCalls).toBe(0);
    const next = await openPreview(harness, "B");
    sessions[2]!.pushFrame(keyFrame(7));
    await waitFor(() => next.sent.some(Buffer.isBuffer));
    // Late closure of the failed socket must not release the replacement.
    harness.handlers.websocket.close(first);
    expect(sessions[2]!.closeCalls).toBe(0);
    expect(next.closes).toEqual([]);
  });
});
