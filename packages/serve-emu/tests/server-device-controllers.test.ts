import { describe, expect, test } from "bun:test";
import type { DeviceContext } from "../src/server.ts";
import {
  createHarness,
  fakeScrcpy,
  fakeWebSocket,
  response,
  waitFor,
  type Harness,
} from "./helpers/server-harness.ts";

async function openController(harness: Harness, serial: string) {
  expect(await harness.request(`/ws?serial=${serial}&control=1&video=0`)).toBeUndefined();
  const socket = fakeWebSocket(harness.server.upgrades.at(-1)!);
  harness.handlers.websocket.open(socket);
  return socket;
}

function touchPackets(session: ReturnType<typeof fakeScrcpy>) {
  return session.fakeControlSocket.writes.filter((packet) => packet[0] === 2);
}

describe("serial-scoped device controllers", () => {
  test("shares preview contexts, skips video work, and scales identical gestures to each device", async () => {
    const sessions = new Map<string, ReturnType<typeof fakeScrcpy>>();
    const harness = await createHarness({ serial: "active" }, {
      listDevices: async () => ["A", "B"].map((serial) => ({ serial, state: "device" })),
      openScrcpy: async (serial) => {
        const session = fakeScrcpy(serial);
        if (serial === "B") { session.meta.width = 1080; session.meta.height = 1920; }
        sessions.set(serial, session);
        return session;
      },
    });
    const a = await openController(harness, "A");
    const b = await openController(harness, "B");
    expect(a.sent[0]).toEqual({ type: "control-ready", serial: "A" });
    expect(b.sent[0]).toEqual({ type: "control-ready", serial: "B" });
    expect(a.sent[1]).toMatchObject({ type: "video-session" });
    expect(sessions.get("A")!.fakeControlSocket.writes).toEqual([]);
    expect(sessions.get("B")!.fakeControlSocket.writes).toEqual([]);
    const contextA = a.data.context as DeviceContext;
    expect(contextA.clients.values().next().value?.awaitingKeyFrame).toBe(false);

    sessions.get("A")!.pushFrame({ type: "frame", data: Buffer.from([0, 0, 1, 0x65]), pts: 1n, isConfig: false, isKey: true });
    await waitFor(() => contextA.frameCount === 1);
    expect(a.sent.some(Buffer.isBuffer)).toBe(false);

    const gesture = { type: "tap", x: 0.25, y: 0.75, requestId: "same-tap" };
    for (const socket of [a, b]) harness.handlers.websocket.message(socket, JSON.stringify(gesture));
    await waitFor(() => [a, b].every((socket) => socket.sent.some((message) => (message as { requestId?: string }).requestId === "same-tap")));
    const packetA = touchPackets(sessions.get("A")!)[0]!;
    const packetB = touchPackets(sessions.get("B")!)[0]!;
    expect([packetA.readInt32BE(10), packetA.readInt32BE(14)]).toEqual([180, 960]);
    expect([packetB.readInt32BE(10), packetB.readInt32BE(14)]).toEqual([270, 1440]);
    expect(sessions.get("active")!.fakeControlSocket.writes).toEqual([]);
    expect(contextA.recorder.summary().eventCount).toBe(1);
    expect((b.data.context as DeviceContext).recorder.summary().eventCount).toBe(1);

    harness.handlers.websocket.message(a, JSON.stringify({ type: "text", text: "private", record: false, requestId: "text" }));
    await waitFor(() => a.sent.some((message) => (message as { requestId?: string }).requestId === "text"));
    expect(contextA.recorder.summary().eventCount).toBe(1);

    await harness.request("/ws?serial=A");
    const preview = fakeWebSocket(harness.server.upgrades.at(-1)!);
    harness.handlers.websocket.open(preview);
    expect(preview.data.context).toBe(a.data.context);
    harness.handlers.websocket.close(a);
    expect(sessions.get("A")!.closeCalls).toBe(0);
  });

  test("owns pointers per socket and releases only that controller's touches", async () => {
    const sessions = new Map<string, ReturnType<typeof fakeScrcpy>>();
    const harness = await createHarness({ serial: "active" }, {
      listDevices: async () => [{ serial: "A", state: "device" }],
      openScrcpy: async (serial) => { const session = fakeScrcpy(serial); sessions.set(serial, session); return session; },
    });
    const first = await openController(harness, "A");
    const second = await openController(harness, "A");
    const session = sessions.get("A")!;
    const down = { type: "touch", action: "down", x: 0.1, y: 0.2, pointerId: 7 };
    for (const socket of [first, second]) harness.handlers.websocket.message(socket, JSON.stringify(down));
    await waitFor(() => touchPackets(session).length === 2);
    const firstPointer = touchPackets(session)[0]!.readBigUInt64BE(2);
    const secondPointer = touchPackets(session)[1]!.readBigUInt64BE(2);
    expect(firstPointer).not.toBe(secondPointer);

    harness.handlers.websocket.message(first, JSON.stringify({ ...down, action: "move", x: 0.6, y: 0.8 }));
    harness.handlers.websocket.message(first, JSON.stringify({ type: "release-input", requestId: "released" }));
    await waitFor(() => first.sent.some((message) => (message as { requestId?: string }).requestId === "released"));
    expect(touchPackets(session).map((packet) => packet[1])).toEqual([0, 0, 2, 1]);
    expect(touchPackets(session)[3]!.readBigUInt64BE(2)).toBe(firstPointer);
    expect([touchPackets(session)[3]!.readInt32BE(10), touchPackets(session)[3]!.readInt32BE(14)]).toEqual([432, 1024]);

    harness.handlers.websocket.close(first);
    expect(touchPackets(session)).toHaveLength(4);
    harness.handlers.websocket.close(second);
    await waitFor(() => session.closeCalls === 1);
    expect(touchPackets(session)[4]![1]).toBe(1);
    expect(touchPackets(session)[4]!.readBigUInt64BE(2)).toBe(secondPointer);
    expect(sessions.get("active")!.fakeControlSocket.writes).toEqual([]);
  });

  test("reports target writer failures independently and preserves active REST scoping", async () => {
    const sessions = new Map<string, ReturnType<typeof fakeScrcpy>>();
    const harness = await createHarness({ serial: "active" }, {
      listDevices: async () => ["A", "B"].map((serial) => ({ serial, state: "device" })),
      openScrcpy: async (serial) => {
        const session = fakeScrcpy(serial);
        if (serial === "B") session.fakeControlSocket.write = () => { throw new Error("B writer failed"); };
        sessions.set(serial, session);
        return session;
      },
    });
    const a = await openController(harness, "A");
    const b = await openController(harness, "B");
    for (const socket of [a, b]) harness.handlers.websocket.message(socket, JSON.stringify({ type: "home", requestId: "key" }));
    await waitFor(() => [a, b].every((socket) => socket.sent.some((message) => (message as { requestId?: string }).requestId === "key")));
    expect(a.sent.at(-1)).toMatchObject({ ok: true, requestId: "key" });
    expect(b.sent.at(-1)).toMatchObject({ ok: false, code: "control-writer-error", requestId: "key" });
    expect(sessions.get("active")!.fakeControlSocket.writes).toEqual([]);
    const result = await response(harness.request("/api/key", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "home" }),
    }));
    expect(result.status).toBe(200);
    expect(sessions.get("active")!.fakeControlSocket.writes).toHaveLength(2);
    expect(sessions.get("A")!.fakeControlSocket.writes).toHaveLength(2);
  });

  test("rejects control requests on read-only previews and unauthorized opted-in sockets", async () => {
    const harness = await createHarness({ serial: "active", token: "secret" }, {
      listDevices: async () => [{ serial: "A", state: "device" }],
      openScrcpy: async (serial) => fakeScrcpy(serial),
    });
    expect((await response(harness.request("/ws?serial=A&control=1&video=0"))).status).toBe(401);
    expect((await response(harness.request("/ws?serial=A&control=1&video=0", {
      headers: { authorization: "Bearer secret", origin: "http://evil.example" },
    }))).status).toBe(403);
    await harness.request("/ws?serial=A", { headers: { authorization: "Bearer secret" } });
    const preview = fakeWebSocket(harness.server.upgrades.at(-1)!);
    harness.handlers.websocket.open(preview);
    expect(preview.sent.some((message) => (message as { type?: string }).type === "control-ready")).toBe(false);
    harness.handlers.websocket.message(preview, JSON.stringify({ type: "release-input", requestId: "readonly" }));
    expect(preview.sent.at(-1)).toMatchObject({ ok: false, code: "preview_read_only", requestId: "readonly" });
  });

  test("flushes a queued explicit touch release before disposing the final controller", async () => {
    const callbacks: Array<() => void> = [];
    const target = fakeScrcpy("A");
    target.fakeControlSocket.write = (packet, callback) => {
      target.fakeControlSocket.writes.push(Buffer.from(packet));
      callbacks.push(() => callback?.());
      return true;
    };
    const harness = await createHarness({ serial: "active" }, {
      listDevices: async () => [{ serial: "A", state: "device" }],
      openScrcpy: async (serial) => serial === "A" ? target : fakeScrcpy(serial),
    });
    const controller = await openController(harness, "A");
    harness.handlers.websocket.message(controller, JSON.stringify({ type: "touch", action: "down", x: 0.5, y: 0.5 }));
    harness.handlers.websocket.message(controller, JSON.stringify({ type: "release-input" }));
    harness.handlers.websocket.close(controller);
    expect(target.closeCalls).toBe(0);
    await waitFor(() => callbacks.length === 1);
    expect(touchPackets(target).map((packet) => packet[1])).toEqual([0]);
    callbacks.shift()!();
    await waitFor(() => callbacks.length === 1);
    expect(touchPackets(target).map((packet) => packet[1])).toEqual([0, 1]);
    expect(target.closeCalls).toBe(0);
    callbacks.shift()!();
    await waitFor(() => target.closeCalls === 1);
  });
});
