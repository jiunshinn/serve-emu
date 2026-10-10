import { describe, expect, test } from "bun:test";
import {
  ControlInputQueue,
  type ControlBinaryWriter,
  type ControlInputClock,
} from "../src/control-input-queue.ts";
import {
  createHarness,
  response,
  waitFor,
  type FakeWebSocket,
  type Harness,
} from "./helpers/server-harness.ts";

const IMMEDIATE_CLOCK: ControlInputClock = {
  async sleep(_ms, signal) {
    if (signal.aborted) throw signal.reason;
  },
};

/** Holds every gesture step sleep until the test releases it. */
class SteppedClock implements ControlInputClock {
  readonly #waiting: Array<() => void> = [];
  #free = false;

  get waiting(): number {
    return this.#waiting.length;
  }

  async sleep(_ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason;
    if (this.#free) return;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      this.#waiting.push(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      });
    });
  }

  releaseOne(): void {
    this.#waiting.shift()?.();
  }

  releaseAll(): void {
    this.#free = true;
    for (const release of this.#waiting.splice(0)) release();
  }
}

type PendingWrite = {
  resolve: () => void;
  reject: (reason: unknown) => void;
  signal: AbortSignal;
  onAbort: () => void;
};

class ControlledWriter implements ControlBinaryWriter {
  readonly packets: Buffer[] = [];
  pending: PendingWrite | null = null;
  #blockNext = false;
  #failNext = false;
  #closed: Error | null = null;

  blockNextWrite(): void {
    this.#blockNext = true;
  }

  failNextWrite(): void {
    this.#failNext = true;
  }

  write(packet: Buffer, signal: AbortSignal): Promise<void> {
    this.packets.push(Buffer.from(packet));
    if (this.#closed) return Promise.reject(this.#closed);
    if (this.#failNext) {
      this.#failNext = false;
      return Promise.reject(new Error("injected control writer failure"));
    }
    if (!this.#blockNext) return Promise.resolve();
    this.#blockNext = false;

    return new Promise<void>((resolve, reject) => {
      const pending: PendingWrite = {
        resolve,
        reject,
        signal,
        onAbort: () => {},
      };
      pending.onAbort = () => {
        if (this.pending !== pending) return;
        this.pending = null;
        signal.removeEventListener("abort", pending.onAbort);
        reject(signal.reason);
      };
      signal.addEventListener("abort", pending.onAbort, { once: true });
      this.pending = pending;
      if (signal.aborted) pending.onAbort();
    });
  }

  release(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    pending.signal.removeEventListener("abort", pending.onAbort);
    pending.resolve();
  }

  close(reason: Error): void {
    if (!this.#closed) this.#closed = reason;
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    pending.signal.removeEventListener("abort", pending.onAbort);
    pending.reject(this.#closed);
  }
}

/**
 * The shared server harness with each device's input queue writing to its
 * own ControlledWriter (`writers`) instead of the fake control socket.
 */
async function createInputHarness(options: {
  serials?: string[];
  maxDepth?: number;
  clock?: ControlInputClock;
} = {}) {
  const serials = options.serials ?? ["device-a"];
  const writers = new Map(
    serials.map((serial) => [serial, new ControlledWriter()]),
  );
  const queues = new Map<string, ControlInputQueue>();
  const harness = await createHarness(
    { serials },
    {
      createInputQueue: (session) => {
        const writer = writers.get(session.serial);
        if (!writer) throw new Error(`missing fake writer ${session.serial}`);
        const queue = new ControlInputQueue({
          writer,
          clock: options.clock ?? IMMEDIATE_CLOCK,
          maxDepth: options.maxDepth,
        });
        queues.set(session.serial, queue);
        return queue;
      },
    },
  );
  return { harness, writers, queues };
}

function post(
  harness: Harness,
  path: string,
  body: unknown,
): Promise<Response> {
  return response(
    harness.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function json(
  value: Response | Promise<Response | undefined>,
): Promise<any> {
  return (await response(Promise.resolve(value))).json();
}

describe("server control input integration", () => {
  test("records normalized gestures in enqueue order before completion", async () => {
    const { harness, writers } = await createInputHarness();
    const writer = writers.get("device-a")!;
    try {
      writer.blockNextWrite();
      const swipeResponse = post(harness, "/api/swipe", {
        x1: 0.1,
        y1: 0.8,
        x2: 0.9,
        y2: 0.2,
        durationMs: 80,
      });
      await waitFor(() => writer.pending !== null, "swipe did not start");

      const textResponse = post(harness, "/api/text", {
        text: "a".repeat(301),
      });
      let snapshot: any;
      await waitFor(async () => {
        snapshot = await json(harness.request("/api/session"));
        return snapshot.events.length === 2;
      }, "accepted inputs were not recorded");

      expect(snapshot.events.map((event: any) => event.gesture.type)).toEqual([
        "swipe",
        "text",
      ]);
      expect(snapshot.events[1].gesture.text).toBe("a".repeat(300));

      writer.release();
      const [swipe, text] = await Promise.all([swipeResponse, textResponse]);
      expect(await json(swipe)).toMatchObject({
        ok: true,
        status: "completed",
      });
      expect(await json(text)).toMatchObject({
        ok: true,
        status: "completed",
      });
    } finally {
      writer.release();
    }
  });

  test("returns a structured 429 when the queue rejects admission", async () => {
    const { harness, writers } = await createInputHarness({ maxDepth: 1 });
    const writer = writers.get("device-a")!;
    try {
      writer.blockNextWrite();
      const first = post(harness, "/api/tap", { x: 0.2, y: 0.3 });
      await waitFor(() => writer.pending !== null, "first tap did not start");

      const rejected = await post(harness, "/api/tap", { x: 0.4, y: 0.5 });
      expect(rejected.status).toBe(429);
      expect(await json(rejected)).toMatchObject({
        ok: false,
        error: { code: "rate_limited", reason: "control-queue-overloaded" },
      });
      const snapshot = await json(harness.request("/api/session"));
      expect(snapshot.events).toHaveLength(1);

      writer.release();
      expect(await json(await first)).toMatchObject({
        ok: true,
        status: "completed",
      });
    } finally {
      writer.release();
    }
  });

  test("reports WebSocket completion, coalescing, and failure while honoring ack:false", async () => {
    const { harness, writers, queues } = await createInputHarness();
    const writer = writers.get("device-a")!;
    const queue = queues.get("device-a")!;
    try {
      const ws = await harness.openWebSocket();
      await waitFor(
        () => writer.packets.length === 1 && queue.snapshot().depth === 0,
        "initial reset-video packet did not drain",
      );

      harness.handlers.websocket.message(
        ws,
        JSON.stringify({ type: "key", keycode: 66 }),
      );
      await waitFor(() => ws.sent.length === 1, "completed ACK missing");
      expect(ws.sent[0]).toMatchObject({ ok: true, status: "completed" });

      harness.handlers.websocket.message(ws, JSON.stringify({
        type: "touch", action: "down", x: 0.2, y: 0.2, pointerId: 1, ack: false,
      }));
      await waitFor(() => queue.snapshot().depth === 0);
      writer.blockNextWrite();
      harness.handlers.websocket.message(
        ws,
        JSON.stringify({ type: "tap", x: 0.5, y: 0.5, ack: false }),
      );
      await waitFor(() => writer.pending !== null, "tap did not block");
      harness.handlers.websocket.message(
        ws,
        JSON.stringify({
          type: "touch",
          action: "move",
          x: 0.2,
          y: 0.2,
          pointerId: 1,
        }),
      );
      harness.handlers.websocket.message(
        ws,
        JSON.stringify({
          type: "touch",
          action: "move",
          x: 0.8,
          y: 0.8,
          pointerId: 1,
        }),
      );
      await waitFor(() => queue.snapshot().depth === 3, "moves did not queue");
      writer.release();
      await waitFor(() => ws.sent.length === 3, "move ACKs missing");
      expect(ws.sent.slice(1)).toEqual([
        { ok: true, status: "coalesced" },
        { ok: true, status: "completed" },
      ]);

      writer.failNextWrite();
      harness.handlers.websocket.message(
        ws,
        JSON.stringify({ type: "key", keycode: 20, requestId: "failed-key" }),
      );
      await waitFor(() => ws.sent.length === 4, "failure ACK missing");
      expect(ws.sent[3]).toMatchObject({
        ok: false,
        status: "failed",
        code: "control-dispatch-failed",
        requestId: "failed-key",
      });

      harness.handlers.websocket.message(
        ws,
        JSON.stringify({ type: "key", keycode: 21, ack: false }),
      );
      harness.handlers.websocket.message(
        ws,
        JSON.stringify({ type: "not-a-gesture", ack: false }),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(ws.sent).toHaveLength(4);
    } finally {
      writer.release();
    }
  });

  test("a new client's reset-video is written between the steps of a running swipe", async () => {
    const clock = new SteppedClock();
    const { harness, writers } = await createInputHarness({ clock });
    const writer = writers.get("device-a")!;
    try {
      const swipe = post(harness, "/api/swipe", {
        x1: 0.5,
        y1: 0.8,
        x2: 0.5,
        y2: 0.2,
        durationMs: 1_000,
      });
      await waitFor(
        () => writer.packets.length === 1 && clock.waiting === 1,
        "swipe did not start",
      );

      // Opening a client asks for a key frame while the swipe is sleeping.
      await harness.openWebSocket();
      clock.releaseOne();
      await waitFor(() => writer.packets.length >= 3, "swipe step not written");
      // Touch down, then the reset ahead of the next touch move, not after
      // the whole one-second swipe.
      expect(writer.packets.slice(0, 3).map((packet) => packet[0])).toEqual([
        2, 17, 2,
      ]);

      clock.releaseAll();
      expect((await swipe).status).toBe(200);
      expect(
        writer.packets.filter((packet) => packet[0] === 17),
      ).toHaveLength(1);
    } finally {
      clock.releaseAll();
    }
  });

  test("rejects a reset-video request during cooldown after the input queue fails", async () => {
    const { harness, writers, queues } = await createInputHarness();
    const writer = writers.get("device-a")!;
    const queue = queues.get("device-a")!;
    try {
      const ws = await harness.openWebSocket();
      await waitFor(
        () => writer.packets.length === 1 && queue.snapshot().depth === 0,
        "initial reset-video packet did not drain",
      );

      writer.failNextWrite();
      harness.handlers.websocket.message(
        ws,
        JSON.stringify({ type: "key", keycode: 20, requestId: "failed-key" }),
      );
      await waitFor(() => ws.sent.length === 1, "failure ACK missing");
      expect(ws.sent[0]).toMatchObject({
        ok: false,
        status: "failed",
        code: "control-dispatch-failed",
      });
      expect(queue.snapshot().closed).toBe(true);

      harness.handlers.websocket.message(
        ws,
        JSON.stringify({ type: "reset-video" }),
      );
      await waitFor(() => ws.sent.length === 2, "reset rejection ACK missing");
      expect(ws.sent[1]).toMatchObject({
        ok: false,
        status: "rejected",
        code: "control-dispatch-failed",
      });
    } finally {
      writer.release();
    }
  });

  test("switching rejects old pending work without writing it to the new session", async () => {
    const { harness, writers } = await createInputHarness({
      serials: ["device-a", "device-b"],
    });
    const oldWriter = writers.get("device-a")!;
    const newWriter = writers.get("device-b")!;
    try {
      oldWriter.blockNextWrite();
      const oldInput = post(harness, "/api/tap", { x: 0.25, y: 0.75 });
      await waitFor(() => oldWriter.pending !== null, "old tap did not start");

      const switched = await post(harness, "/api/devices/select", {
        serial: "device-b",
      });
      expect(await json(switched)).toMatchObject({
        ok: true,
        serial: "device-b",
      });

      const cancelled = await oldInput;
      expect(cancelled.status).toBe(503);
      expect(await json(cancelled)).toMatchObject({
        ok: false,
        error: { code: "service_unavailable", reason: "control-queue-closed" },
      });
      expect(oldWriter.packets).toHaveLength(1);
      expect(newWriter.packets).toHaveLength(0);

      oldWriter.release();
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(oldWriter.packets).toHaveLength(1);

      const next = await post(harness, "/api/key", { key: "home" });
      expect(await json(next)).toMatchObject({
        ok: true,
        status: "completed",
      });
      expect(newWriter.packets).toHaveLength(2);
      expect(oldWriter.packets).toHaveLength(1);

      const snapshot = await json(harness.request("/api/session"));
      expect(snapshot.events).toHaveLength(1);
      expect(snapshot.events[0].gesture).toEqual({ type: "home" });
      expect(harness.sessions.get("device-a")!.closeCalls).toBe(1);
    } finally {
      oldWriter.release();
      newWriter.release();
    }
  });
});


test("WebSocket disconnect releases only its own pointers even when the queue is full", async () => {
  const { harness, writers, queues } = await createInputHarness({ maxDepth: 4 });
  const queue = queues.get("device-a")!;
  const writer = writers.get("device-a")!;
  const send = (ws: FakeWebSocket, payload: unknown) => harness.handlers.websocket.message(ws, JSON.stringify(payload));
  try {
    const first = await harness.openWebSocket();
    const second = await harness.openWebSocket();
    await waitFor(() => queue.snapshot().depth === 0);
    const down = { type: "touch", action: "down", x: 0.5, y: 0.5, pointerId: 1, ack: false };
    send(first, down);
    await waitFor(() => queue.snapshot().depth === 0);
    send(second, { ...down, record: false });
    await waitFor(() => queue.snapshot().depth === 0);
    const downs = writer.packets.filter(p => p[0] === 2 && p[1] === 0);
    expect(downs).toHaveLength(2);
    expect(downs[0]!.readBigUInt64BE(2)).not.toBe(downs[1]!.readBigUInt64BE(2));
    writer.blockNextWrite();
    send(first, { type: "home", ack: false });
    await waitFor(() => writer.pending !== null);
    send(second, { type: "home", ack: false });
    expect(queue.snapshot()).toMatchObject({ depth: 2, reservedReleases: 2 });
    harness.handlers.websocket.close(first);
    harness.handlers.websocket.close(first);
    expect(queue.snapshot()).toMatchObject({ depth: 3, reservedReleases: 1 });
    writer.release();
    await waitFor(() => queue.snapshot().depth === 0);
    let ups = writer.packets.filter(p => p[0] === 2 && p[1] === 1);
    expect(ups).toHaveLength(1);
    expect(ups[0]!.readBigUInt64BE(2)).toBe(downs[0]!.readBigUInt64BE(2));
    harness.handlers.websocket.close(second);
    await waitFor(() => queue.snapshot().depth === 0);
    ups = writer.packets.filter(p => p[0] === 2 && p[1] === 1);
    expect(ups).toHaveLength(2);
    expect(ups[1]!.readBigUInt64BE(2)).toBe(downs[1]!.readBigUInt64BE(2));
    expect(queue.snapshot().reservedReleases).toBe(0);
    const session = await json(harness.request("/api/session"));
    const releases = session.events.filter((e: any) => e.source === "ws:disconnect");
    expect(releases).toHaveLength(1);
  } finally {
    writer.release();
  }
});

describe("WebSocket touch recording follows the pointer's down", () => {
  type Step = { action: "down" | "move" | "up" | "disconnect"; record?: boolean };
  const cases: Array<[string, Step[], string[]]> = [
    ["recorded down, unrecorded up", [{ action: "down" }, { action: "up", record: false }], ["down", "up"]],
    [
      "recorded down, unrecorded move and up",
      [{ action: "down" }, { action: "move", record: false }, { action: "up", record: false }],
      ["down", "move", "up"],
    ],
    ["unrecorded down, recorded up", [{ action: "down", record: false }, { action: "up" }], []],
    [
      "unrecorded down, recorded move and up",
      [{ action: "down", record: false }, { action: "move" }, { action: "up" }],
      [],
    ],
    ["recorded down, then disconnect", [{ action: "down" }, { action: "disconnect" }], ["down", "up"]],
    [
      "unrecorded down, recorded move, then disconnect",
      [{ action: "down", record: false }, { action: "move" }, { action: "disconnect" }],
      [],
    ],
  ];

  test.each(cases)("%s", async (_name, steps, recorded) => {
    const { harness, queues } = await createInputHarness();
    const queue = queues.get("device-a")!;
    const ws = await harness.openWebSocket();
    await waitFor(() => queue.snapshot().depth === 0);
    for (const step of steps) {
      if (step.action === "disconnect") {
        harness.handlers.websocket.close(ws);
      } else {
        harness.handlers.websocket.message(
          ws,
          JSON.stringify({
            type: "touch",
            action: step.action,
            x: 0.5,
            y: 0.5,
            pointerId: 7,
            ack: false,
            ...(step.record === undefined ? {} : { record: step.record }),
          }),
        );
      }
      await waitFor(() => queue.snapshot().depth === 0);
    }
    const session = await json(harness.request("/api/session"));
    const touches = session.events
      .filter((e: any) => e.kind === "gesture" && e.gesture.type === "touch")
      .map((e: any) => e.gesture.action);
    expect(touches).toEqual(recorded);
  });
});
