import { describe, expect, test } from "bun:test";
import { DeviceControls, type DeviceControlState } from "../src/ui/lib/device-controls.ts";

class FakeSocket {
  constructor(readonly serial: string) {}
  readyState = 0;
  bufferedAmount = 0;
  failSend = false;
  sent: Array<Record<string, unknown>> = [];
  onopen: WebSocket["onopen"] = null;
  onclose: WebSocket["onclose"] = null;
  onerror: WebSocket["onerror"] = null;
  onmessage: WebSocket["onmessage"] = null;

  open(confirmControl = true) {
    this.readyState = 1;
    this.onopen?.call(this as unknown as WebSocket, {} as Event);
    if (confirmControl) this.receive({ type: "control-ready", serial: this.serial });
  }
  send(text: string) {
    if (this.failSend) throw new Error("send failed");
    this.sent.push(JSON.parse(text));
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.call(this as unknown as WebSocket, {} as CloseEvent);
  }
  error() { this.onerror?.call(this as unknown as WebSocket, {} as Event); }
  receive(value: unknown) {
    this.onmessage?.call(this as unknown as WebSocket, { data: JSON.stringify(value) } as MessageEvent);
  }
}

function harness(serials = ["a", "b"]) {
  let states: Record<string, DeviceControlState> = {};
  let nextRetry = 0;
  const retries = new Map<number, () => void>();
  const handshakes = new Map<number, () => void>();
  const sockets = new Map<string, FakeSocket[]>();
  const controls = new DeviceControls({
    createSocket(serial) {
      const socket = new FakeSocket(serial);
      sockets.set(serial, [...(sockets.get(serial) ?? []), socket]);
      return socket as unknown as WebSocket;
    },
    onChange(next) { states = next; },
    scheduleReconnect(callback) {
      const id = ++nextRetry;
      retries.set(id, callback);
      return () => { retries.delete(id); };
    },
    scheduleHandshakeTimeout(callback, delayMs) {
      expect(delayMs).toBe(5_000);
      const id = ++nextRetry;
      handshakes.set(id, callback);
      return () => { handshakes.delete(id); };
    },
  });
  controls.setSerials(serials);
  return {
    controls, sockets, retries, handshakes,
    get states() { return states; },
    latest(serial: string) { return sockets.get(serial)!.at(-1)!; },
    openAll() { for (const series of sockets.values()) series.at(-1)!.open(); },
    retry() {
      const [id, callback] = retries.entries().next().value!;
      retries.delete(id);
      callback();
    },
    timeout() {
      const [id, callback] = handshakes.entries().next().value!;
      handshakes.delete(id);
      callback();
    },
  };
}

const touch = (action: "down" | "move" | "up", pointerId = 1) =>
  ({ type: "touch", action, pointerId, x: 0.25, y: 0.75 });

describe("multi-device control connections", () => {
  test("requires a matching control handshake before any input or release command", () => {
    const h = harness(["a"]);
    const socket = h.latest("a");
    socket.open(false);
    socket.receive({ type: "video-session", size: { width: 1080, height: 1920 } });
    socket.receive({ type: "control-ready", serial: "another-device" });
    expect(h.states.a!.status).toBe("connecting");
    expect(h.controls.send(["a"], { type: "home" })).toBe(false);
    h.controls.releaseAll();
    expect(socket.sent).toEqual([]);
    expect(h.handshakes.size).toBe(1);

    socket.receive({ type: "control-ready", serial: "a" });
    expect(h.states.a).toEqual({ status: "ready", error: null });
    expect(h.handshakes.size).toBe(0);
    expect(h.controls.send(["a"], { type: "home" })).toBe(true);
  });

  test("old backends time out with restart guidance and recover after a real handshake", () => {
    const h = harness(["a"]);
    const old = h.latest("a");
    old.open(false);
    h.timeout();
    expect(old.readyState).toBe(3);
    expect(old.sent).toEqual([]);
    expect(h.states.a!.status).toBe("disconnected");
    expect(h.states.a!.error).toContain("Restart serve-emu and refresh this page");
    expect(h.controls.send(["a"], { type: "home" })).toBe(false);
    expect(h.states.a!.error).toContain("Restart serve-emu and refresh this page");
    expect(h.handshakes.size).toBe(0);
    expect(h.retries.size).toBe(1);

    h.retry();
    const current = h.latest("a");
    current.open(false);
    old.receive({ type: "control-ready", serial: "a" });
    expect(h.states.a!.status).toBe("connecting");
    expect(current.sent).toEqual([]);
    current.receive({ type: "control-ready", serial: "a" });
    expect(h.states.a).toEqual({ status: "ready", error: null });
  });

  test("read-only rejections show restart guidance and release a held peer", () => {
    const h = harness();
    h.openAll();
    h.controls.send(["a", "b"], touch("down"));
    h.latest("b").receive({ ok: false, code: "preview_read_only", error: "device previews are read-only" });
    expect(h.states.b!.error).toContain("Restart serve-emu and refresh this page");
    expect(h.latest("b").readyState).toBe(3);
    expect(h.latest("a").sent.at(-1)).toEqual({ type: "release-input", ack: false });
    expect(h.controls.send(["a", "b"], touch("up"))).toBe(false);
  });

  test("removal and close cancel pending handshake timers", () => {
    const h = harness();
    h.latest("a").open(false);
    const staleTimeout = [...h.handshakes.values()][0]!;
    h.latest("b").open(false);
    h.controls.setSerials(["b"]);
    expect(h.handshakes.size).toBe(1);
    staleTimeout();
    expect(h.states.a).toBeUndefined();
    expect(h.retries.size).toBe(0);
    h.controls.close();
    expect(h.handshakes.size).toBe(0);
    expect(h.latest("b").sent).toEqual([]);
  });

  test("stale handshake timeouts cannot close a replacement or confirmed socket", () => {
    const h = harness(["a"]);
    h.latest("a").open(false);
    const staleTimeout = [...h.handshakes.values()][0]!;
    h.latest("a").error();
    expect(h.handshakes.size).toBe(0);
    h.retry();
    h.latest("a").open(false);
    staleTimeout();
    expect(h.latest("a").readyState).toBe(1);
    expect(h.states.a!.status).toBe("connecting");
    const confirmedTimeout = [...h.handshakes.values()][0]!;
    h.latest("a").receive({ type: "control-ready", serial: "a" });
    confirmedTimeout();
    expect(h.latest("a").readyState).toBe(1);
    expect(h.states.a).toEqual({ status: "ready", error: null });
    expect(h.handshakes.size).toBe(0);
  });

  test("checks every target before sending anything", () => {
    const h = harness();
    h.latest("a").open();
    expect(h.controls.send(["a", "b"], { type: "text", text: "hello" })).toBe(false);
    expect(h.latest("a").sent).toEqual([]);
    expect(h.states.b!.error).toContain("b: Connection unavailable");

    h.latest("b").open();
    expect(h.controls.send(["a", "a", "b"], { type: "text", text: "hello" }, false)).toBe(true);
    expect(h.latest("a").sent).toHaveLength(1);
    expect(h.latest("b").sent).toHaveLength(1);
    expect(h.latest("b").sent[0]).toMatchObject({ type: "text", text: "hello", ack: false });
    expect(h.latest("a").sent[0]!.requestId).not.toBe(h.latest("b").sent[0]!.requestId);
  });

  test("pins touch membership from down through up", () => {
    const h = harness();
    h.openAll();
    expect(h.controls.send(["a", "b"], touch("down"))).toBe(true);
    expect(h.controls.send(["a"], touch("move"), false)).toBe(true);
    expect(h.controls.send(["b"], touch("up"))).toBe(true);
    expect(h.latest("a").sent.map((message) => message.action)).toEqual(["down", "move", "up"]);
    expect(h.latest("b").sent.map((message) => message.action)).toEqual(["down", "move", "up"]);
    expect(h.controls.send(["a", "b"], touch("move"))).toBe(false);
  });

  test("reconnection releases peers and never resumes an old pointer", () => {
    const h = harness();
    h.openAll();
    h.controls.send(["a", "b"], touch("down"));
    h.latest("b").close();
    expect(h.latest("a").sent.at(-1)).toEqual({ type: "release-input", ack: false });
    h.retry();
    h.latest("b").open();
    expect(h.controls.send(["a", "b"], touch("move"))).toBe(false);
    expect(h.controls.send(["a", "b"], touch("up"))).toBe(false);
    expect(h.latest("b").sent).toEqual([]);
    expect(h.controls.send(["a", "b"], touch("down"))).toBe(true);
  });

  test("unrelated reconnects do not interrupt the selected devices", () => {
    const h = harness(["a", "b", "c"]);
    h.openAll();
    h.controls.send(["a", "b"], touch("down"));
    h.latest("c").close();
    expect(h.latest("a").sent).toHaveLength(1);
    expect(h.controls.send(["a", "b"], touch("move"))).toBe(true);
  });

  test("target removal releases held input and list reordering preserves sockets", () => {
    const h = harness();
    h.openAll();
    h.controls.setSerials(["b", "a"]);
    expect(h.sockets.get("a")).toHaveLength(1);
    h.controls.send(["a", "b"], touch("down"));
    const oldB = h.latest("b");
    h.controls.setSerials(["a"]);
    expect(oldB.sent.at(-1)).toEqual({ type: "release-input", ack: false });
    expect(oldB.readyState).toBe(3);
    expect(h.controls.send(["a"], touch("up"))).toBe(false);
    expect(h.states.b).toBeUndefined();
  });

  test("reports bounded serial-specific server errors and releases a rejected gesture", () => {
    const h = harness();
    h.openAll();
    h.controls.send(["a", "b"], touch("down"));
    h.latest("b").receive({ ok: false, error: "denied".repeat(1000) });
    expect(h.states.b!.error).toStartWith("b: denied");
    expect(h.states.b!.error!.length).toBeLessThan(400);
    expect(h.latest("a").sent.at(-1)).toEqual({ type: "release-input", ack: false });
    expect(h.controls.send(["a", "b"], touch("up"))).toBe(false);
    h.controls.clearErrors();
    expect(h.states.b!.error).toBeNull();
  });

  test("drops stale socket responses after reconnect", () => {
    const h = harness();
    h.openAll();
    const oldB = h.latest("b");
    oldB.error();
    h.retry();
    h.latest("b").open();
    oldB.receive({ ok: false, error: "old failure" });
    oldB.onopen?.call(oldB as unknown as WebSocket, {} as Event);
    expect(h.states.b).toEqual({ status: "ready", error: null });
  });

  test("reports send exceptions without queuing a partial broadcast for retry", () => {
    const h = harness();
    h.openAll();
    h.latest("b").failSend = true;
    expect(h.controls.send(["a", "b"], touch("down"))).toBe(false);
    expect(h.latest("a").sent.map((message) => message.type)).toEqual(["touch", "release-input"]);
    expect(h.states.b!.error).toContain("Other targets may have received it");
    h.retry();
    h.latest("b").open();
    expect(h.latest("b").sent).toEqual([]);
  });

  test("bounds queued input before broadcasting to a congested target", () => {
    const h = harness();
    h.openAll();
    h.controls.send(["a", "b"], touch("down"));
    h.latest("b").bufferedAmount = 65 * 1024;
    expect(h.controls.send(["a", "b"], touch("move"), false)).toBe(false);
    expect(h.latest("a").sent.map((message) => message.type)).toEqual(["touch", "release-input"]);
    expect(h.latest("b").readyState).toBe(3);
    expect(h.states.b!.error).toContain("too slow");
  });

  test("limits connections to sixteen with visible capacity errors", () => {
    const serials = Array.from({ length: 17 }, (_, index) => `device-${String(index).padStart(2, "0")}`);
    const h = harness(serials.reverse());
    expect(h.sockets.size).toBe(16);
    expect(h.states["device-16"]!.error).toContain("At most 16");
    expect(h.states["device-16"]!.status).toBe("disconnected");
    h.controls.setSerials(serials.filter((serial) => serial !== "device-00"));
    expect(h.latest("device-00").readyState).toBe(3);
    expect(h.sockets.get("device-16")).toHaveLength(1);
  });

  test("closing cancels retries and releases held input", () => {
    const h = harness();
    h.openAll();
    h.controls.send(["a"], touch("down"));
    h.latest("b").close();
    const staleRetry = [...h.retries.values()][0]!;
    h.controls.close();
    expect(h.retries.size).toBe(0);
    expect(h.latest("a").sent.at(-1)).toEqual({ type: "release-input", ack: false });
    staleRetry();
    expect(h.sockets.get("b")).toHaveLength(1);
    expect(h.controls.send(["a"], { type: "home" })).toBe(false);
  });
});
