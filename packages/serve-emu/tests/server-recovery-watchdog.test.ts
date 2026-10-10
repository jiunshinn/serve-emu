import { describe, expect, test } from "bun:test";
import type { VideoPacket } from "../src/scrcpy.ts";
import { deferred } from "./helpers/deferred.ts";
import { ManualClock } from "./helpers/manual-clock.ts";
import {
  createHarness,
  fakeScrcpy,
  fakeWebSocket,
  response,
  waitFor,
  type FakeWebSocket,
  type Harness,
} from "./helpers/server-harness.ts";

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

async function readHealth(harness: Harness): Promise<any> {
  return (await response(harness.request("/health"))).json();
}

function post(harness: Harness, path: string, body: unknown): Promise<Response> {
  return response(
    harness.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function sentJson(ws: FakeWebSocket): unknown[] {
  return ws.sent.filter((value) => !(value instanceof Uint8Array));
}

function sentFrames(ws: FakeWebSocket): unknown[] {
  return ws.sent.filter((value) => value instanceof Uint8Array);
}

async function pushFrame(
  harness: Harness,
  serial: string,
  packet: VideoPacket,
  expectedFrameCount: number,
): Promise<void> {
  harness.sessions.get(serial)!.pushFrame(packet);
  await waitFor(
    async () => (await readHealth(harness)).frames === expectedFrameCount,
    `frame ${expectedFrameCount} was not processed`,
  );
}

describe("server recovery watchdog", () => {
  test("an idle screen backs off stall resets, /health says idle, and a tap does not reset it (#165)", async () => {
    const clock = new ManualClock();
    const harness = await createHarness(
      { serials: ["A"] },
      { recoveryClock: clock },
    );
    const session = harness.session;
    try {
      await harness.openWebSocket();
      await pushFrame(harness, "A", keyFrame(), 1);
      const opened = session.fakeControlSocket.writes.length;

      // Nothing changes on screen: the first quiet window is a stall.
      clock.advance(3_000);
      clock.fireActive();
      await waitFor(() => session.fakeControlSocket.writes.length === opened + 1);
      // The restarted encoder answers with its key frame, then goes quiet.
      await pushFrame(harness, "A", keyFrame(), 2);
      clock.advance(3_000);
      clock.fireActive();

      let health = await readHealth(harness);
      expect(session.fakeControlSocket.writes).toHaveLength(opened + 1);
      expect(health).toMatchObject({
        sourceState: "idle",
        lastVideoResetReason: "video source stalled",
        keyFrameRecovery: { stallResetAfterMs: 5_000 },
      });

      // An action that changes nothing on screen sends no frame. It must not
      // reset the backoff or trigger a check of its own.
      const beforeTap = session.fakeControlSocket.writes.length;
      expect((await post(harness, "/api/tap", { x: 0.5, y: 0.5 })).status).toBe(200);
      // The tap's touch down and up.
      await waitFor(() => session.fakeControlSocket.writes.length === beforeTap + 2);
      health = await readHealth(harness);
      expect(health.keyFrameRecovery.stallResetAfterMs).toBe(5_000);
      clock.advance(3_000);
      clock.fireActive();
      health = await readHealth(harness);
      // The next restart is the idle check due 5 s after the last frame, not
      // a "stalled" check of the tap's.
      expect(health).toMatchObject({
        videoResetRequests: 3,
        lastVideoResetReason: "video source idle",
        keyFrameRecovery: { stallResetAfterMs: 10_000 },
      });
    } finally {
      harness.started.stop();
    }
  });

  test("a staggered client joins the pending restart, then retries continue every window", async () => {
    const clock = new ManualClock();
    const harness = await createHarness(
      { serials: ["A"] },
      { recoveryClock: clock },
    );
    const session = harness.session;
    try {
      await harness.openWebSocket();
      await waitFor(() => session.fakeControlSocket.writes.length === 1);
      expect(session.fakeControlSocket.writes).toHaveLength(1);

      for (let second = 1; second <= 10; second++) {
        clock.advance(1_000);
        await pushFrame(harness, "A", deltaFrame(), second);
        clock.fireActive();
        if (second === 1) await harness.openWebSocket();
      }

      await waitFor(() => session.fakeControlSocket.writes.length === 4);
      expect(session.fakeControlSocket.writes).toHaveLength(4);
      const health = await readHealth(harness);
      expect(health).toMatchObject({
        status: "streaming",
        sourceFps: 1,
        sourceFrameAgeMs: 0,
        videoResetRequests: 4,
        lastVideoResetReason: "client awaiting keyframe",
        keyFrameRecovery: {
          awaitingClients: 2,
          oldestAwaitingAgeMs: 10_000,
          lastResetAttemptAt: "1970-01-01T00:00:09.000Z",
          pendingResetAgeMs: 1_000,
          resetBackoffMs: 2_500,
        },
      });
      expect(health.clientsDetail).toEqual([
        expect.objectContaining({
          awaitingKeyFrame: true,
          awaitingKeyFrameSinceAt: "1970-01-01T00:00:00.000Z",
          awaitingKeyFrameAgeMs: 10_000,
          lastKeyFrameRequestAt: "1970-01-01T00:00:09.000Z",
        }),
        expect.objectContaining({
          awaitingKeyFrame: true,
          awaitingKeyFrameSinceAt: "1970-01-01T00:00:01.000Z",
          awaitingKeyFrameAgeMs: 9_000,
          lastKeyFrameRequestAt: "1970-01-01T00:00:09.000Z",
        }),
      ]);
    } finally {
      harness.started.stop();
    }
  });

  test("a session packet waits for its key frame instead of restarting the encoder", async () => {
    const clock = new ManualClock();
    const harness = await createHarness(
      { serials: ["A"] },
      { recoveryClock: clock },
    );
    const session = harness.session;
    try {
      const ws = await harness.openWebSocket();
      await waitFor(() => session.fakeControlSocket.writes.length === 1);
      await pushFrame(harness, "A", keyFrame(), 1);
      clock.advance(1_000);

      session.pushFrame({
        type: "session",
        width: 1280,
        height: 720,
        clientResized: false,
      });
      await waitFor(
        () => sentJson(ws).length === 1,
        "video-session was not broadcast",
      );
      expect(sentJson(ws)[0]).toEqual({
        type: "video-session",
        size: { width: 1280, height: 720 },
      });
      clock.advance(1_000);
      clock.fireActive();
      let health = await readHealth(harness);
      expect(session.fakeControlSocket.writes).toHaveLength(1);
      expect(health).toMatchObject({
        size: { width: 1280, height: 720 },
        videoResetRequests: 1,
        keyFrameRecovery: { awaitingClients: 1 },
      });

      await pushFrame(harness, "A", keyFrame(), 2);
      health = await readHealth(harness);
      expect(health.keyFrameRecovery.awaitingClients).toBe(0);
      expect(sentFrames(ws)).toHaveLength(2);
      expect(session.fakeControlSocket.writes).toHaveLength(1);
    } finally {
      harness.started.stop();
    }
  });

  test("coalesces a client reset-video request while a restart is pending", async () => {
    const clock = new ManualClock();
    const harness = await createHarness(
      { serials: ["A"] },
      { recoveryClock: clock },
    );
    const session = harness.session;
    try {
      const ws = await harness.openWebSocket();
      await waitFor(() => session.fakeControlSocket.writes.length === 1);

      clock.advance(1_000);
      harness.handlers.websocket.message(
        ws,
        JSON.stringify({ type: "reset-video" }),
      );
      await waitFor(() => sentJson(ws).length === 1, "coalesced ACK missing");
      expect(sentJson(ws)[0]).toEqual({ ok: true, status: "coalesced" });
      expect(session.fakeControlSocket.writes).toHaveLength(1);

      await pushFrame(harness, "A", keyFrame(), 1);
      harness.handlers.websocket.message(
        ws,
        JSON.stringify({ type: "reset-video" }),
      );
      await waitFor(() => sentJson(ws).length === 2, "reset ACK missing");
      expect(sentJson(ws)[1]).toEqual({ ok: true, status: "completed" });
      expect(session.fakeControlSocket.writes).toHaveLength(2);
      expect(await readHealth(harness)).toMatchObject({
        videoResetRequests: 2,
        lastVideoResetReason: "client requested keyframe",
        keyFrameRecovery: { pendingResetAgeMs: 0 },
      });
    } finally {
      harness.started.stop();
    }
  });

  test("clears recovery only for keyframes accepted by each websocket", async () => {
    const clock = new ManualClock();
    const harness = await createHarness(
      { serials: ["A"] },
      { recoveryClock: clock },
    );
    try {
      const accepted = await harness.openWebSocket({ sendResult: 1 });
      const backpressured = await harness.openWebSocket({ sendResult: -1 });
      const closed = await harness.openWebSocket({ sendResult: 0 });
      const throwing = await harness.openWebSocket({ throwOnSend: true });
      const buffered = await harness.openWebSocket({
        sendResult: 1,
        bufferedAmount: 600 * 1024,
      });
      const healthyAfterThrow = await harness.openWebSocket({ sendResult: 1 });

      await pushFrame(harness, "A", keyFrame(), 1);

      const health = await readHealth(harness);
      expect(health.status).toBe("streaming");
      expect(health.clients).toBe(4);
      expect(health.keyFrameRecovery.awaitingClients).toBe(2);
      expect(
        health.clientsDetail.map((entry: any) => entry.awaitingKeyFrame),
      ).toEqual([false, true, true, false]);
      expect(sentFrames(accepted)).toHaveLength(1);
      expect(sentFrames(backpressured)).toHaveLength(1);
      expect(sentFrames(closed)).toHaveLength(1);
      expect(sentFrames(throwing)).toHaveLength(0);
      expect(throwing.closes).toEqual([
        { code: 1011, reason: "frame send failed" },
      ]);
      expect(sentFrames(buffered)).toHaveLength(0);
      expect(sentFrames(healthyAfterThrow)).toHaveLength(1);
    } finally {
      harness.started.stop();
    }
  });

  test("owns exactly one timer through terminal recovery, switch, and shutdown", async () => {
    const clock = new ManualClock();
    const harness = await createHarness(
      { serials: ["A", "B", "C"] },
      { recoveryClock: clock },
    );
    try {
      expect(clock.activeIntervals).toBe(1);
      harness.sessions.get("A")!.endFrames();
      await waitFor(async () => (await readHealth(harness)).status === "stopped");
      expect(clock.activeIntervals).toBe(0);

      const selectedB = await post(harness, "/api/devices/select", {
        serial: "B",
      });
      expect(selectedB.status).toBe(200);
      expect(clock.activeIntervals).toBe(1);

      const oldTimer = clock.timers.at(-1)!;
      const selectedC = await post(harness, "/api/devices/select", {
        serial: "C",
      });
      expect(selectedC.status).toBe(200);
      expect(clock.activeIntervals).toBe(1);
      const clientC = await harness.openWebSocket();
      await waitFor(
        () =>
          harness.sessions.get("C")!.fakeControlSocket.writes.length === 1,
      );
      expect(harness.sessions.get("C")!.fakeControlSocket.writes).toHaveLength(1);

      clock.advance(5_000);
      oldTimer.callback();
      expect(harness.sessions.get("B")!.fakeControlSocket.writes).toHaveLength(0);
      expect(harness.sessions.get("C")!.fakeControlSocket.writes).toHaveLength(1);
      expect(clientC.closes).toHaveLength(0);
    } finally {
      await harness.started.stop();
    }
    expect(clock.activeIntervals).toBe(0);
    expect(harness.server.stopArguments).toHaveLength(1);
  });

  test("resets source and keyframe recovery health on a streaming switch", async () => {
    const clock = new ManualClock();
    const harness = await createHarness(
      { serials: ["A", "B"] },
      { recoveryClock: clock },
    );
    try {
      await harness.openWebSocket();
      clock.advance(2_000);
      await pushFrame(harness, "A", deltaFrame(), 1);
      clock.advance(100);

      expect(await readHealth(harness)).toMatchObject({
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

      const response = await post(harness, "/api/devices/select", {
        serial: "B",
      });
      expect(response.status).toBe(200);
      expect(await readHealth(harness)).toMatchObject({
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
    const sessions = [fakeScrcpy("A"), fakeScrcpy("B")];
    const startGate = deferred();
    const startCalls: string[] = [];
    const clock = new ManualClock();
    const harness = await createHarness(
      { sessions },
      {
        recoveryClock: clock,
        openScrcpy: async (serial) => {
          startCalls.push(serial);
          if (serial === "B") await startGate.promise;
          const session = sessions.find((fake) => fake.serial === serial);
          if (!session) throw new Error(`missing fake session ${serial}`);
          return session;
        },
      },
    );
    const switching = post(harness, "/api/devices/select", { serial: "B" });
    await waitFor(() => startCalls.includes("B"));

    const stopping = harness.started.stop();
    await waitFor(() => clock.activeIntervals === 0);
    expect(clock.activeIntervals).toBe(0);
    startGate.resolve();

    const response = await switching;
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "invalid_request", message: "device session manager is closed" },
    });
    expect(harness.sessions.get("B")!.closeCalls).toBe(1);
    expect(clock.activeIntervals).toBe(0);
    await stopping;
  });

  test("rejects a pre-switch websocket upgrade and its reset messages", async () => {
    const clock = new ManualClock();
    const harness = await createHarness(
      { serials: ["A", "B"] },
      { recoveryClock: clock },
    );
    try {
      expect(await harness.request("/ws")).toBeUndefined();
      const staleData = harness.server.upgrades.at(-1);
      if (!staleData) throw new Error("upgrade data was not captured");
      const response = await post(harness, "/api/devices/select", {
        serial: "B",
      });
      expect(response.status).toBe(200);

      const stale = fakeWebSocket(staleData);
      harness.handlers.websocket.open(stale);
      expect(stale.closes).toEqual([
        { code: 1012, reason: "device session changed" },
      ]);
      harness.handlers.websocket.message(
        stale,
        JSON.stringify({ type: "reset-video" }),
      );
      expect(sentJson(stale)).toEqual([
        expect.objectContaining({ ok: false }),
      ]);
      expect(harness.sessions.get("A")!.fakeControlSocket.writes).toHaveLength(0);
      expect(harness.sessions.get("B")!.fakeControlSocket.writes).toHaveLength(0);
    } finally {
      harness.started.stop();
    }
  });

  test("exposes an admitted reset even when its queued write later fails", async () => {
    const clock = new ManualClock();
    const harness = await createHarness(
      { serials: ["A"] },
      { recoveryClock: clock },
    );
    const session = harness.session;
    session.fakeControlSocket.throwOnWrite = new Error(
      "injected reset write failure",
    );
    try {
      await harness.openWebSocket();
      await waitFor(() => session.fakeControlSocket.writes.length === 1);
      let health = await readHealth(harness);
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

      clock.advance(2_500);
      clock.fireActive();
      health = await readHealth(harness);
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
    const clock = new ManualClock();
    const harness = await createHarness(
      { serials: ["A"] },
      { recoveryClock: clock },
    );
    try {
      for (let frame = 1; frame <= 50; frame++) {
        await pushFrame(harness, "A", deltaFrame(), frame);
      }
      clock.advance(2_500);
      clock.fireActive();

      expect(await readHealth(harness)).toMatchObject({
        frames: 50,
        sourceFps: 20,
        sourceFrameAgeMs: 2_500,
      });
    } finally {
      harness.started.stop();
    }
  });
});
