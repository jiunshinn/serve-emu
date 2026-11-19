import { describe, expect, test } from "bun:test";
import {
  SessionRecoveryWatchdog,
  type RecoveryClientState,
  type RecoveryWatchdogClock,
} from "../src/session-recovery-watchdog.ts";
import { ManualClock } from "./helpers/manual-clock.ts";

const client = (
  overrides: Partial<RecoveryClientState> = {},
): RecoveryClientState => ({
  awaitingKeyFrame: false,
  awaitingKeyFrameSinceMs: null,
  lastKeyFrameRequestMs: null,
  ...overrides,
});

function harness(options: {
  clients?: RecoveryClientState[];
  requestReset?: (reason: string, nowMs: number) => boolean;
} = {}) {
  const clock = new ManualClock();
  const clients = options.clients ?? [];
  const resets: Array<{ reason: string; nowMs: number }> = [];
  const watchdog = new SessionRecoveryWatchdog({
    clock,
    clients: () => clients,
    requestReset:
      options.requestReset ??
      ((reason, nowMs) => {
        resets.push({ reason, nowMs });
        return true;
      }),
  });
  return { clock, clients, resets, watchdog };
}

describe("SessionRecoveryWatchdog", () => {
  test("retries across three windows while continuous delta frames arrive", () => {
    const waiting = client();
    const { clock, clients, resets, watchdog } = harness();
    clients.push(waiting);
    watchdog.markAwaiting(waiting);

    expect(watchdog.requestVideoReset("client opened")).toBe(true);
    expect(waiting.awaitingKeyFrameSinceMs).toBe(0);
    expect(waiting.lastKeyFrameRequestMs).toBe(0);

    for (let step = 0; step < 15; step++) {
      clock.advance(500);
      watchdog.recordFrame();
      watchdog.tick();
    }

    expect(resets).toEqual([
      { reason: "client opened", nowMs: 0 },
      { reason: "client awaiting keyframe", nowMs: 2_500 },
      { reason: "client awaiting keyframe", nowMs: 5_000 },
      { reason: "client awaiting keyframe", nowMs: 7_500 },
    ]);
    expect(waiting.awaitingKeyFrameSinceMs).toBe(0);
    expect(waiting.lastKeyFrameRequestMs).toBe(7_500);
    expect(watchdog.snapshot().sourceFrameAgeMs).toBe(0);
  });

  test("never abandons a waiting client when key frames never come (#127)", () => {
    // An encoder that ignores the periodic interval: only delta frames, for
    // ten minutes. The client must keep getting resets at the rate limit.
    const waiting = client();
    const { clock, clients, resets, watchdog } = harness();
    clients.push(waiting);
    watchdog.markAwaiting(waiting);
    watchdog.requestVideoReset("client opened");

    for (let step = 0; step < 1_200; step++) {
      clock.advance(500);
      watchdog.recordFrame();
      watchdog.tick();
    }

    expect(resets).toHaveLength(1 + 600_000 / 2_500);
    const gaps = resets.slice(1).map((reset, index) => reset.nowMs - resets[index]!.nowMs);
    expect(new Set(gaps)).toEqual(new Set([2_500]));
    expect(resets.at(-1)).toEqual({ reason: "client awaiting keyframe", nowMs: 600_000 });
    expect(watchdog.snapshot().awaitingClients).toBe(1);
  });

  test("one admitted reset covers all waiting clients and rate-limits retries", () => {
    const first = client();
    const second = client();
    const { clock, clients, resets, watchdog } = harness({
      clients: [first, second],
    });
    watchdog.markAwaiting(first);
    watchdog.markAwaiting(second);

    expect(watchdog.requestVideoReset("first client")).toBe(true);
    expect(watchdog.requestVideoReset("second client")).toBe(false);
    expect(first.lastKeyFrameRequestMs).toBe(0);
    expect(second.lastKeyFrameRequestMs).toBe(0);

    clock.advance(2_499);
    watchdog.tick();
    expect(resets).toHaveLength(1);
    clock.advance(1);
    watchdog.tick();
    expect(resets).toHaveLength(2);
    expect(resets[1]).toEqual({
      reason: "client awaiting keyframe",
      nowMs: 2_500,
    });
    expect(clients).toHaveLength(2);
  });

  test("a staggered client joins the pending restart instead of restarting again", () => {
    const first = client();
    const second = client();
    const { clock, resets, watchdog } = harness({ clients: [first, second] });
    watchdog.markAwaiting(first);
    expect(watchdog.requestVideoReset("first client")).toBe(true);

    clock.advance(600);
    watchdog.markAwaiting(second);
    expect(watchdog.requestVideoReset("staggered client")).toBe(false);
    expect(first.lastKeyFrameRequestMs).toBe(0);
    expect(second.lastKeyFrameRequestMs).toBeNull();

    clock.advance(1_899);
    watchdog.tick();
    expect(resets).toHaveLength(1);
    clock.advance(1);
    watchdog.tick();

    expect(resets).toEqual([
      { reason: "first client", nowMs: 0 },
      { reason: "client awaiting keyframe", nowMs: 2_500 },
    ]);
    expect(first.lastKeyFrameRequestMs).toBe(2_500);
    expect(second.lastKeyFrameRequestMs).toBe(2_500);
  });

  test("a client that joins after the pending key frame gets its own reset", () => {
    const first = client();
    const second = client();
    const { clock, resets, watchdog } = harness({ clients: [first, second] });
    watchdog.markAwaiting(first);
    expect(watchdog.requestVideoReset("first client")).toBe(true);

    clock.advance(200);
    watchdog.recordFrame(true);
    watchdog.keyFrameAccepted(first);
    clock.advance(400);
    watchdog.markAwaiting(second);

    expect(watchdog.requestVideoReset("staggered client")).toBe(true);
    expect(resets).toEqual([
      { reason: "first client", nowMs: 0 },
      { reason: "staggered client", nowMs: 600 },
    ]);
    expect(first.lastKeyFrameRequestMs).toBeNull();
    expect(second.lastKeyFrameRequestMs).toBe(600);
  });

  test("repeated triggers cannot restart an encoder before its key frame arrives", () => {
    // A slow device answers each reset with a key frame 1.5 s later, and a
    // second reset cancels the pending one. Watchdog ticks plus the
    // browser's 400 ms keyframe requests used to restart it indefinitely.
    const viewer = client();
    const restarts: number[] = [];
    let keyFrameDueMs: number | null = null;
    const { clock, watchdog } = harness({
      clients: [viewer],
      requestReset: (_reason, nowMs) => {
        restarts.push(nowMs);
        keyFrameDueMs = nowMs + 1_500;
        return true;
      },
    });
    watchdog.recordFrame();
    watchdog.markAwaiting(viewer);
    clock.advance(3_000);

    for (let step = 0; step < 100 && viewer.awaitingKeyFrame; step++) {
      if (clock.nowMs % 1_000 === 0) watchdog.tick();
      if (clock.nowMs % 400 === 0) {
        watchdog.requestVideoReset("client requested keyframe");
      }
      clock.advance(100);
      if (keyFrameDueMs !== null && clock.nowMs >= keyFrameDueMs) {
        watchdog.recordFrame(true);
        watchdog.keyFrameAccepted(viewer);
      }
    }

    expect(viewer.awaitingKeyFrame).toBe(false);
    expect(restarts).toEqual([3_000]);
    expect(watchdog.snapshot().pendingResetAgeMs).toBeNull();
  });

  test("backs off restarts that produce no frames, up to the cap", () => {
    const waiting = client();
    const { clock, resets, watchdog } = harness({ clients: [waiting] });
    watchdog.markAwaiting(waiting);

    for (let elapsed = 0; elapsed <= 100_000; elapsed += 500) {
      watchdog.requestVideoReset("client requested keyframe");
      clock.advance(500);
    }

    expect(resets.map((reset) => reset.nowMs)).toEqual([
      0, 2_500, 7_500, 17_500, 37_500, 67_500, 97_500,
    ]);
    expect(watchdog.snapshot()).toMatchObject({
      pendingResetAgeMs: 3_000,
      resetBackoffMs: 30_000,
    });
  });

  test("any frame resets the backoff and a key frame ends the pending restart", () => {
    const { clock, resets, watchdog } = harness();
    expect(watchdog.requestVideoReset("first")).toBe(true);
    clock.advance(2_500);
    expect(watchdog.requestVideoReset("second")).toBe(true);
    expect(watchdog.snapshot()).toMatchObject({
      pendingResetAgeMs: 0,
      resetBackoffMs: 5_000,
    });

    clock.advance(1_000);
    watchdog.recordFrame();
    expect(watchdog.snapshot()).toMatchObject({
      pendingResetAgeMs: 1_000,
      resetBackoffMs: 2_500,
    });
    expect(watchdog.requestVideoReset("still pending")).toBe(false);

    watchdog.recordFrame(true);
    expect(watchdog.snapshot().pendingResetAgeMs).toBeNull();
    expect(watchdog.requestVideoReset("after key frame")).toBe(true);
    expect(resets.map((reset) => reset.reason)).toEqual([
      "first",
      "second",
      "after key frame",
    ]);
  });

  test("an externally admitted reset shares the pending-restart gate", () => {
    const waiting = client();
    const { clock, resets, watchdog } = harness({ clients: [waiting] });
    watchdog.markAwaiting(waiting);

    expect(watchdog.canRequestReset()).toBe(true);
    watchdog.noteResetAdmitted();
    expect(waiting.lastKeyFrameRequestMs).toBe(0);
    expect(watchdog.canRequestReset()).toBe(false);

    clock.advance(2_499);
    expect(watchdog.requestVideoReset("too soon")).toBe(false);
    clock.advance(1);
    expect(watchdog.requestVideoReset("settled")).toBe(true);
    expect(resets).toEqual([{ reason: "settled", nowMs: 2_500 }]);
  });

  test("simultaneous source stall and client retry emit at most one reset", () => {
    const waiting = client();
    const { clock, resets, watchdog } = harness({ clients: [waiting] });
    watchdog.markAwaiting(waiting);
    watchdog.recordFrame();
    expect(watchdog.requestVideoReset("client opened")).toBe(true);

    clock.advance(2_500);
    watchdog.tick();

    expect(resets).toEqual([
      { reason: "client opened", nowMs: 0 },
      { reason: "video source stalled", nowMs: 2_500 },
    ]);
    expect(waiting.lastKeyFrameRequestMs).toBe(2_500);
  });

  test("clears both waiting timestamps only when a keyframe is accepted", () => {
    const waiting = client();
    const { clock, watchdog } = harness({ clients: [waiting] });
    watchdog.markAwaiting(waiting);
    watchdog.requestVideoReset("client opened");
    clock.advance(100);

    watchdog.keyFrameAccepted(waiting);

    expect(waiting).toEqual({
      awaitingKeyFrame: false,
      awaitingKeyFrameSinceMs: null,
      lastKeyFrameRequestMs: null,
    });
    watchdog.markAwaiting(waiting);
    expect(waiting.awaitingKeyFrameSinceMs).toBe(100);
  });

  test("preserves an existing wait start and repairs a missing one", () => {
    const waiting = client({
      awaitingKeyFrame: true,
      awaitingKeyFrameSinceMs: 10,
      lastKeyFrameRequestMs: 20,
    });
    const { clock, watchdog } = harness({ clients: [waiting] });
    clock.advance(50);
    watchdog.markAwaiting(waiting);
    expect(waiting.awaitingKeyFrameSinceMs).toBe(10);
    expect(waiting.lastKeyFrameRequestMs).toBe(20);

    waiting.awaitingKeyFrameSinceMs = null;
    watchdog.markAwaiting(waiting);
    // markAwaiting repairs the field; read it back without the null narrowing.
    expect(waiting.awaitingKeyFrameSinceMs as number | null).toBe(50);
    expect(waiting.lastKeyFrameRequestMs).toBe(20);
  });

  test("normalizes FPS by actual elapsed callback time", () => {
    const { clock, watchdog } = harness();
    for (let i = 0; i < 50; i++) watchdog.recordFrame();
    clock.advance(2_500);

    watchdog.tick();

    expect(watchdog.snapshot().sourceFps).toBe(20);
  });

  test("stopped and superseded interval callbacks are inert", () => {
    const waiting = client();
    const { clock, clients, resets, watchdog } = harness();
    clients.push(waiting);
    watchdog.markAwaiting(waiting);
    watchdog.start();
    watchdog.start();
    expect(clock.activeIntervals).toBe(1);
    const oldTimer = clock.timers[0]!;

    watchdog.stop();
    expect(clock.activeIntervals).toBe(0);
    clock.advance(5_000);
    oldTimer.callback();
    expect(resets).toHaveLength(0);

    watchdog.start();
    expect(clock.activeIntervals).toBe(1);
    oldTimer.callback();
    expect(resets).toHaveLength(0);
    clock.fireActive();
    expect(resets).toEqual([
      { reason: "first video frame not received", nowMs: 5_000 },
    ]);
  });

  test("a synchronous reset failure consumes cooldown without marking clients", () => {
    const waiting = client();
    let attempts = 0;
    const { clock, watchdog } = harness({
      clients: [waiting],
      requestReset: () => {
        attempts++;
        throw new Error("socket closed");
      },
    });
    watchdog.markAwaiting(waiting);

    expect(watchdog.requestVideoReset("first")).toBe(false);
    expect(watchdog.requestVideoReset("same tick")).toBe(false);
    expect(attempts).toBe(1);
    expect(waiting.lastKeyFrameRequestMs).toBeNull();
    clock.advance(499);
    expect(watchdog.requestVideoReset("too soon")).toBe(false);
    expect(attempts).toBe(1);
    clock.advance(1);
    expect(watchdog.requestVideoReset("retry")).toBe(false);
    expect(attempts).toBe(2);
  });

  test("reports source and keyframe recovery ages independently", () => {
    const waiting = client();
    const { clock, watchdog } = harness({ clients: [waiting] });
    watchdog.markAwaiting(waiting);
    clock.advance(2_000);
    watchdog.recordFrame();
    clock.advance(100);

    expect(watchdog.snapshot()).toMatchObject({
      sourceFrameAgeMs: 100,
      awaitingClients: 1,
      oldestAwaitingAgeMs: 2_100,
    });
  });

  describe("idle screens (#165)", () => {
    /**
     * A static screen: every admitted reset is answered by one key frame and
     * ten repeats 100 ms apart, then nothing. Steps time in 100 ms and ticks
     * once a second, like the server's interval.
     */
    function runStaticScreen(
      h: ReturnType<typeof harness>,
      durationMs: number,
      onStep?: (nowMs: number) => void,
    ) {
      const burst: number[] = [];
      let answered = h.resets.length;
      for (let elapsed = 0; elapsed < durationMs; elapsed += 100) {
        h.clock.advance(100);
        while (answered < h.resets.length) {
          const at = h.resets[answered++]!.nowMs;
          for (let frame = 0; frame <= 10; frame++) burst.push(at + 100 * (frame + 1));
        }
        while (burst.length > 0 && burst[0]! <= h.clock.nowMs) {
          const first = burst.length % 11 === 0;
          burst.shift();
          h.watchdog.recordFrame(first);
        }
        onStep?.(h.clock.nowMs);
        if (h.clock.nowMs % 1_000 === 0) h.watchdog.tick();
      }
    }

    test("stall resets on a static screen back off to the cap", () => {
      const h = harness({ clients: [client()] });
      h.watchdog.recordFrame(true);
      runStaticScreen(h, 600_000);

      const gaps = h.resets.slice(1).map((reset, i) => reset.nowMs - h.resets[i]!.nowMs);
      // 2.5 s, then 5, 10, 20 and 30 s of quiet after each 1 s burst.
      expect(gaps.slice(0, 4)).toEqual([7_000, 12_000, 22_000, 32_000]);
      expect(new Set(gaps.slice(4))).toEqual(new Set([32_000]));
      expect(h.resets.length).toBeLessThan(25);
      expect(h.resets[0]).toEqual({ reason: "video source stalled", nowMs: 3_000 });
      expect(new Set(h.resets.slice(1).map((reset) => reset.reason))).toEqual(
        new Set(["video source idle"]),
      );
      expect(h.watchdog.snapshot()).toMatchObject({
        sourceState: "idle",
        stallResetAfterMs: 30_000,
      });
    });

    test("occasional small changes on an idle screen keep the backoff", () => {
      const h = harness({ clients: [client()] });
      h.watchdog.recordFrame(true);
      // A status bar tick every 60 s: one changed frame plus 10 repeats.
      const tick = (nowMs: number) => {
        const sinceTick = nowMs % 60_000;
        if (sinceTick >= 100 && sinceTick <= 1_100 && sinceTick % 100 === 0) {
          h.watchdog.recordFrame();
        }
      };
      runStaticScreen(h, 600_000, tick);
      expect(h.resets.length).toBeLessThan(35);
      expect(h.watchdog.snapshot().stallResetAfterMs).toBe(30_000);
    });

    test("frames beyond a restart's burst bring the base threshold back", () => {
      const h = harness({ clients: [client()] });
      h.watchdog.recordFrame(true);
      runStaticScreen(h, 60_000);
      expect(h.watchdog.snapshot().stallResetAfterMs).toBe(30_000);

      // The screen starts changing: a steady stream of frames.
      for (let frame = 0; frame < 20; frame++) {
        h.clock.advance(50);
        h.watchdog.recordFrame();
      }
      expect(h.watchdog.snapshot()).toMatchObject({
        sourceState: "streaming",
        stallResetAfterMs: 2_500,
      });
      const before = h.resets.length;
      h.clock.advance(2_500);
      h.watchdog.tick();
      expect(h.resets.slice(before)).toEqual([
        { reason: "video source stalled", nowMs: h.clock.nowMs },
      ]);
    });

    test("an encoder that dies on an idle screen is found by the next check", () => {
      const h = harness({ clients: [client()] });
      h.watchdog.recordFrame(true);
      runStaticScreen(h, 60_000);
      expect(h.watchdog.snapshot().stallResetAfterMs).toBe(30_000);
      const before = h.resets.length;
      const diedAt = h.clock.nowMs;

      // The encoder dies: from now on no reset is answered.
      const states = new Set<string>();
      for (let second = 1; second <= 90; second++) {
        h.clock.advance(1_000);
        h.watchdog.tick();
        const retries = h.resets.slice(before);
        if (retries.length > 0 && h.clock.nowMs - retries[0]!.nowMs >= 3_000) {
          states.add(h.watchdog.snapshot().sourceState);
        }
      }
      const retries = h.resets.slice(before);
      // Found by the next idle check, within the 30 s cap of the last frame.
      expect(retries[0]!.reason).toBe("video source idle");
      expect(retries[0]!.nowMs - diedAt).toBeLessThanOrEqual(32_000);
      // Unanswered from then on: stalled, with the no-frame settle backoff.
      expect(states).toEqual(new Set(["stalled"]));
      expect(new Set(retries.slice(1).map((reset) => reset.reason))).toEqual(
        new Set(["video source stalled"]),
      );
      const gaps = retries.slice(1).map((reset, i) => reset.nowMs - retries[i]!.nowMs);
      // The settle window: 2.5 s (rounded up to the tick), then doubling.
      expect(gaps.slice(0, 4)).toEqual([3_000, 5_000, 10_000, 20_000]);
    });

    test("reports starting, streaming, idle, and stalled sources", () => {
      const h = harness({ clients: [client()] });
      expect(h.watchdog.snapshot().sourceState).toBe("starting");
      h.clock.advance(5_000);
      expect(h.watchdog.snapshot().sourceState).toBe("stalled");

      h.watchdog.recordFrame(true);
      expect(h.watchdog.snapshot().sourceState).toBe("streaming");
      h.clock.advance(2_500);
      expect(h.watchdog.snapshot().sourceState).toBe("idle");

      // A reset that the encoder answers keeps the source idle.
      expect(h.watchdog.requestVideoReset("probe")).toBe(true);
      h.clock.advance(100);
      h.watchdog.recordFrame(true);
      h.clock.advance(5_000);
      expect(h.watchdog.snapshot().sourceState).toBe("idle");

      // A reset that gets no frame for a settle window is a stall.
      expect(h.watchdog.requestVideoReset("probe")).toBe(true);
      h.clock.advance(2_499);
      expect(h.watchdog.snapshot().sourceState).toBe("idle");
      h.clock.advance(1);
      expect(h.watchdog.snapshot().sourceState).toBe("stalled");
    });
  });
});
