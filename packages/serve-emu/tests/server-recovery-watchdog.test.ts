import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import type { VideoPacket, ScrcpySession } from "../src/scrcpy.ts";
import {
  startServer,
  type ServerDependencies,
} from "../src/server.ts";
import type { RecoveryWatchdogClock } from "../src/session-recovery-watchdog.ts";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Timer = {
  callback: () => void;
  active: boolean;
};

class ManualClock implements RecoveryWatchdogClock {
  nowMs = 0;
  readonly timers: Timer[] = [];

  now(): number {
    return this.nowMs;
  }

  setInterval(callback: () => void): unknown {
    const timer = { callback, active: true };
    this.timers.push(timer);
    return timer;
  }

  clearInterval(value: unknown): void {
    (value as Timer).active = false;
  }

  advance(ms: number): void {
    this.nowMs += ms;
  }

  fireActive(): void {
    for (const timer of this.timers) {
      if (timer.active) timer.callback();
    }
  }

  get activeTimers(): number {
    return this.timers.filter((timer) => timer.active).length;
  }
}

class FrameFeed {
  #packets: Array<VideoPacket | null> = [];
  #waiting: Deferred<VideoPacket | null> | null = null;

  read(): Promise<VideoPacket | null> {
    const packet = this.#packets.shift();
    if (packet !== undefined) return Promise.resolve(packet);
    this.#waiting = deferred<VideoPacket | null>();
    return this.#waiting.promise;
  }

  push(packet: VideoPacket | null): void {
    const waiting = this.#waiting;
    if (waiting) {
      this.#waiting = null;
      waiting.resolve(packet);
      return;
    }
    this.#packets.push(packet);
  }
}

class FakeControlSocket extends EventEmitter {
  readonly writes: Buffer[] = [];
  readonly destroyed = false;
  readonly writable = true;
  returnValue = true;
  throwOnWrite = false;

  write(packet: Buffer, callback?: (err?: Error | null) => void): boolean {
    this.writes.push(Buffer.from(packet));
    if (this.throwOnWrite) throw new Error("injected reset write failure");
    callback?.();
    return this.returnValue;
  }
}

type FakeSession = ScrcpySession & {
  feed: FrameFeed;
  fakeControlSocket: FakeControlSocket;
  closeCount: number;
};

function fakeSession(serial: string): FakeSession {
  const feed = new FrameFeed();
  const fakeControlSocket = new FakeControlSocket();
  const proc = new EventEmitter();
  let closed = false;
  const value = {
    transport: "scrcpy",
    meta: {
      deviceName: serial,
      codecId: "h264",
      width: 720,
      height: 1280,
    },
    protocol: 3,
    videoReader: {},
    controlSocket: fakeControlSocket,
    fakeControlSocket,
    proc,
    scid: serial.padEnd(8, "0").slice(0, 8),
    localPort: 27_200,
    serial,
    feed,
    closeCount: 0,
    readFrame: () => feed.read(),
    close() {
      value.closeCount++;
      if (closed) return;
      closed = true;
      feed.push(null);
    },
  };
  return value as unknown as FakeSession;
}

type CapturedServe = {
  serve: typeof Bun.serve;
  options(): any;
  upgrades: any[];
  stopCalls: number;
};

function captureServe(): CapturedServe {
  let options: any = null;
  const upgrades: any[] = [];
  const capture: CapturedServe = {
    serve: ((nextOptions: unknown) => {
      options = nextOptions;
      return {
        port: 33_030,
        hostname: "127.0.0.1",
        upgrade(_req: Request, upgrade: { data: unknown }) {
          upgrades.push(upgrade.data);
          return true;
        },
        stop() {
          capture.stopCalls++;
        },
      };
    }) as typeof Bun.serve,
    options: () => options,
    upgrades,
    stopCalls: 0,
  };
  return capture;
}

type FakeWebSocketOptions = {
  frameSend?: number | "throw";
  bufferedBytes?: number;
};

type FakeWebSocket = {
  data: any;
  sentJson: unknown[];
  sentFrames: Buffer[];
  closes: Array<{ code?: number; reason?: string }>;
  send(value: string | Buffer): number;
  close(code?: number, reason?: string): void;
  getBufferedAmount(): number;
};

function fakeWebSocket(
  data: unknown,
  options: FakeWebSocketOptions = {},
): FakeWebSocket {
  const sentJson: unknown[] = [];
  const sentFrames: Buffer[] = [];
  const closes: Array<{ code?: number; reason?: string }> = [];
  return {
    data,
    sentJson,
    sentFrames,
    closes,
    send(value) {
      if (typeof value === "string") {
        sentJson.push(JSON.parse(value));
        return 1;
      }
      if (options.frameSend === "throw") {
        throw new Error("injected websocket send failure");
      }
      sentFrames.push(Buffer.from(value));
      return options.frameSend ?? 1;
    },
    close(code, reason) {
      closes.push({ code, reason });
    },
    getBufferedAmount() {
      return options.bufferedBytes ?? 0;
    },
  };
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  message = "condition was not met",
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(message);
}

const deltaFrame = (): VideoPacket => ({
  type: "frame",
  data: Buffer.from([0, 0, 0, 1, 0x41]),
  pts: 1n,
  isConfig: false,
  isKey: false,
});

const keyFrame = (): VideoPacket => ({
  type: "frame",
  data: Buffer.from([0, 0, 0, 1, 0x65]),
  pts: 2n,
  isConfig: false,
  isKey: true,
});

type Harness = Awaited<ReturnType<typeof createHarness>>;

async function createHarness(options: {
  serials?: string[];
  delayedSerials?: string[];
} = {}) {
  const serials = options.serials ?? ["A"];
  const sessions = new Map(
    serials.map((serial) => [serial, fakeSession(serial)]),
  );
  const startGates = new Map(
    (options.delayedSerials ?? []).map((serial) => [
      serial,
      deferred<void>(),
    ]),
  );
  const startCalls: string[] = [];
  const clock = new ManualClock();
  const captured = captureServe();
  const dependencies: ServerDependencies = {
    startScrcpy: async ({ serial }) => {
      startCalls.push(serial);
      const gate = startGates.get(serial);
      if (gate) await gate.promise;
      const session = sessions.get(serial);
      if (!session) throw new Error(`missing fake session ${serial}`);
      return session;
    },
    listAllDevices: async () =>
      serials.map((serial) => ({ serial, state: "device" })),
    serve: captured.serve,
    recoveryClock: clock,
  };
  const started = await startServer(
    { serial: serials[0]!, port: 33_030 },
    dependencies,
  );
  const handlers = captured.options();

  const request = async (
    path: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const response = await handlers.fetch(
      new Request(`http://127.0.0.1:33030${path}`, init),
      {
        upgrade(_req: Request, upgrade: { data: unknown }) {
          captured.upgrades.push(upgrade.data);
          return true;
        },
      },
    );
    if (!(response instanceof Response)) {
      throw new Error(`${path} did not return a Response`);
    }
    return response;
  };

  const post = (path: string, body: unknown) =>
    request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const upgrade = async (): Promise<unknown> => {
    const result = await handlers.fetch(
      new Request("http://127.0.0.1:33030/ws"),
      {
        upgrade(_req: Request, next: { data: unknown }) {
          captured.upgrades.push(next.data);
          return true;
        },
      },
    );
    expect(result).toBeUndefined();
    const data = captured.upgrades.at(-1);
    if (!data) throw new Error("upgrade data was not captured");
    return data;
  };

  const openWebSocket = async (
    wsOptions: FakeWebSocketOptions = {},
    data?: unknown,
  ): Promise<FakeWebSocket> => {
    const ws = fakeWebSocket(data ?? (await upgrade()), wsOptions);
    handlers.websocket.open(ws);
    return ws;
  };

  const health = async (): Promise<any> =>
    (await request("/health")).json();

  return {
    started,
    handlers,
    sessions,
    startGates,
    startCalls,
    clock,
    captured,
    request,
    post,
    upgrade,
    openWebSocket,
    health,
  };
}

async function pushFrame(
  harness: Harness,
  serial: string,
  packet: VideoPacket,
  expectedFrameCount: number,
): Promise<void> {
  harness.sessions.get(serial)!.feed.push(packet);
  await waitFor(async () => {
    const health = await harness.health();
    return health.frames === expectedFrameCount;
  }, `frame ${expectedFrameCount} was not processed`);
}

describe("server recovery watchdog", () => {
  test("retries across three windows with continuous deltas and a staggered client", async () => {
    const harness = await createHarness();
    const session = harness.sessions.get("A")!;
    try {
      await harness.openWebSocket();
      await waitFor(() => session.fakeControlSocket.writes.length === 1);
      expect(session.fakeControlSocket.writes).toHaveLength(1);

      for (let second = 1; second <= 10; second++) {
        harness.clock.advance(1_000);
        await pushFrame(harness, "A", deltaFrame(), second);
        harness.clock.fireActive();
        if (second === 1) await harness.openWebSocket();
      }

      await waitFor(() => session.fakeControlSocket.writes.length === 5);
      expect(session.fakeControlSocket.writes).toHaveLength(5);
      const health = await harness.health();
      expect(health).toMatchObject({
        status: "streaming",
        sourceFps: 1,
        sourceFrameAgeMs: 0,
        videoResetRequests: 5,
        lastVideoResetReason: "client awaiting keyframe",
        keyFrameRecovery: {
          awaitingClients: 2,
          oldestAwaitingAgeMs: 10_000,
          lastResetAttemptAt: "1970-01-01T00:00:10.000Z",
        },
      });
      expect(health.clientsDetail).toEqual([
        expect.objectContaining({
          awaitingKeyFrame: true,
          awaitingKeyFrameSinceAt: "1970-01-01T00:00:00.000Z",
          awaitingKeyFrameAgeMs: 10_000,
          lastKeyFrameRequestAt: "1970-01-01T00:00:10.000Z",
        }),
        expect.objectContaining({
          awaitingKeyFrame: true,
          awaitingKeyFrameSinceAt: "1970-01-01T00:00:01.000Z",
          awaitingKeyFrameAgeMs: 9_000,
          lastKeyFrameRequestAt: "1970-01-01T00:00:10.000Z",
        }),
      ]);
    } finally {
      harness.started.stop();
    }
  });

  test("clears recovery only for keyframes accepted by each websocket", async () => {
    const harness = await createHarness();
    try {
      const accepted = await harness.openWebSocket({ frameSend: 1 });
      const backpressured = await harness.openWebSocket({ frameSend: -1 });
      const closed = await harness.openWebSocket({ frameSend: 0 });
      const throwing = await harness.openWebSocket({ frameSend: "throw" });
      const buffered = await harness.openWebSocket({
        frameSend: 1,
        bufferedBytes: 600 * 1024,
      });
      const healthyAfterThrow = await harness.openWebSocket({ frameSend: 1 });

      await pushFrame(harness, "A", keyFrame(), 1);

      const health = await harness.health();
      expect(health.status).toBe("streaming");
      expect(health.clients).toBe(4);
      expect(health.keyFrameRecovery.awaitingClients).toBe(2);
      expect(
        health.clientsDetail.map((entry: any) => entry.awaitingKeyFrame),
      ).toEqual([false, true, true, false]);
      expect(accepted.sentFrames).toHaveLength(1);
      expect(backpressured.sentFrames).toHaveLength(1);
      expect(closed.sentFrames).toHaveLength(1);
      expect(throwing.sentFrames).toHaveLength(0);
      expect(throwing.closes).toEqual([
        { code: 1011, reason: "frame send failed" },
      ]);
      expect(buffered.sentFrames).toHaveLength(0);
      expect(healthyAfterThrow.sentFrames).toHaveLength(1);
    } finally {
      harness.started.stop();
    }
  });

  test("owns exactly one timer through terminal recovery, switch, and shutdown", async () => {
    const harness = await createHarness({ serials: ["A", "B", "C"] });
    try {
      expect(harness.clock.activeTimers).toBe(1);
      harness.sessions.get("A")!.feed.push(null);
      await waitFor(async () => (await harness.health()).status === "stopped");
      expect(harness.clock.activeTimers).toBe(0);

      const selectedB = await harness.post("/api/devices/select", {
        serial: "B",
      });
      expect(selectedB.status).toBe(200);
      expect(harness.clock.activeTimers).toBe(1);

      const oldTimer = harness.clock.timers.at(-1)!;
      const selectedC = await harness.post("/api/devices/select", {
        serial: "C",
      });
      expect(selectedC.status).toBe(200);
      expect(harness.clock.activeTimers).toBe(1);
      const clientC = await harness.openWebSocket();
      await waitFor(
        () =>
          harness.sessions.get("C")!.fakeControlSocket.writes.length === 1,
      );
      expect(harness.sessions.get("C")!.fakeControlSocket.writes).toHaveLength(1);

      harness.clock.advance(5_000);
      oldTimer.callback();
      expect(harness.sessions.get("B")!.fakeControlSocket.writes).toHaveLength(0);
      expect(harness.sessions.get("C")!.fakeControlSocket.writes).toHaveLength(1);
      expect(clientC.closes).toHaveLength(0);
    } finally {
      await harness.started.stop();
    }
    expect(harness.clock.activeTimers).toBe(0);
    expect(harness.captured.stopCalls).toBe(1);
  });

  test("resets source and keyframe recovery health on a streaming switch", async () => {
    const harness = await createHarness({ serials: ["A", "B"] });
    try {
      await harness.openWebSocket();
      harness.clock.advance(2_000);
      await pushFrame(harness, "A", deltaFrame(), 1);
      harness.clock.advance(100);

      expect(await harness.health()).toMatchObject({
        serial: "A",
        frames: 1,
        sourceFrameAgeMs: 100,
        videoResetRequests: 1,
        keyFrameRecovery: {
          awaitingClients: 1,
          oldestAwaitingAgeMs: 2_100,
          lastResetAttemptAt: "1970-01-01T00:00:00.000Z",
        },
      });

      const response = await harness.post("/api/devices/select", {
        serial: "B",
      });
      expect(response.status).toBe(200);
      expect(await harness.health()).toMatchObject({
        serial: "B",
        status: "streaming",
        clients: 0,
        frames: 0,
        sourceFps: 0,
        sourceFrameAgeMs: 0,
        videoResetRequests: 0,
        lastVideoResetAt: null,
        lastVideoResetReason: null,
        keyFrameRecovery: {
          awaitingClients: 0,
          oldestAwaitingAgeMs: null,
          lastResetAttemptAt: null,
        },
        clientsDetail: [],
        lastFrameAt: null,
      });
    } finally {
      harness.started.stop();
    }
  });

  test("does not adopt a switch that resolves after server stop", async () => {
    const harness = await createHarness({
      serials: ["A", "B"],
      delayedSerials: ["B"],
    });
    const switching = harness.post("/api/devices/select", { serial: "B" });
    await waitFor(() => harness.startCalls.includes("B"));

    const stopping = harness.started.stop();
    await waitFor(() => harness.clock.activeTimers === 0);
    expect(harness.clock.activeTimers).toBe(0);
    harness.startGates.get("B")!.resolve();

    const response = await switching;
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: "device session manager is closed",
    });
    expect(harness.sessions.get("B")!.closeCount).toBe(1);
    expect(harness.clock.activeTimers).toBe(0);
    await stopping;
  });

  test("rejects a pre-switch websocket upgrade and its reset messages", async () => {
    const harness = await createHarness({ serials: ["A", "B"] });
    try {
      const staleData = await harness.upgrade();
      const response = await harness.post("/api/devices/select", {
        serial: "B",
      });
      expect(response.status).toBe(200);

      const stale = await harness.openWebSocket({}, staleData);
      expect(stale.closes).toEqual([
        { code: 1012, reason: "device session changed" },
      ]);
      harness.handlers.websocket.message(
        stale,
        JSON.stringify({ type: "reset-video" }),
      );
      expect(stale.sentJson).toEqual([
        expect.objectContaining({ ok: false }),
      ]);
      expect(harness.sessions.get("A")!.fakeControlSocket.writes).toHaveLength(0);
      expect(harness.sessions.get("B")!.fakeControlSocket.writes).toHaveLength(0);
    } finally {
      harness.started.stop();
    }
  });

  test("exposes an admitted reset even when its queued write later fails", async () => {
    const harness = await createHarness();
    const session = harness.sessions.get("A")!;
    session.fakeControlSocket.throwOnWrite = true;
    try {
      await harness.openWebSocket();
      await waitFor(() => session.fakeControlSocket.writes.length === 1);
      let health = await harness.health();
      expect(session.fakeControlSocket.writes).toHaveLength(1);
      expect(health).toMatchObject({
        videoResetRequests: 1,
        lastVideoResetAt: "1970-01-01T00:00:00.000Z",
        keyFrameRecovery: {
          awaitingClients: 1,
          lastResetAttemptAt: "1970-01-01T00:00:00.000Z",
        },
      });
      expect(health.clientsDetail[0].lastKeyFrameRequestAt).toBe(
        "1970-01-01T00:00:00.000Z",
      );

      const secondClient = await harness.openWebSocket();
      harness.handlers.websocket.message(
        secondClient,
        JSON.stringify({ type: "reset-video" }),
      );
      expect(session.fakeControlSocket.writes).toHaveLength(1);

      harness.clock.advance(2_500);
      harness.clock.fireActive();
      health = await harness.health();
      expect(session.fakeControlSocket.writes).toHaveLength(1);
      expect(health.keyFrameRecovery.lastResetAttemptAt).toBe(
        "1970-01-01T00:00:02.500Z",
      );
      expect(health.videoResetRequests).toBe(1);
    } finally {
      harness.started.stop();
    }
  });

  test("normalizes server FPS after a delayed timer callback", async () => {
    const harness = await createHarness();
    try {
      for (let frame = 1; frame <= 50; frame++) {
        await pushFrame(harness, "A", deltaFrame(), frame);
      }
      harness.clock.advance(2_500);
      harness.clock.fireActive();

      expect(await harness.health()).toMatchObject({
        frames: 50,
        sourceFps: 20,
        sourceFrameAgeMs: 2_500,
      });
    } finally {
      harness.started.stop();
    }
  });
});
