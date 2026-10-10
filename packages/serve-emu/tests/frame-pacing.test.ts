import { describe, expect, test } from "bun:test";
import {
  StreamSessionResources,
  type ClosableStreamFrame,
} from "../src/ui/lib/stream-lifecycle.ts";
import { presentOldestFrame, VsyncEstimator } from "../src/ui/lib/stream-performance.ts";

const VSYNC = 1000 / 60;

class Frame implements ClosableStreamFrame {
  closed = false;
  constructor(readonly timestamp: number) {}
  close(): void {
    this.closed = true;
  }
}

describe("presentOldestFrame (#75)", () => {
  test.each([
    [{ queued: 2, oldestAgeMs: 10 }, true],
    [{ queued: 2, oldestAgeMs: 24.9 }, true],
    [{ queued: 1, oldestAgeMs: 5 }, false],
    [{ queued: 3, oldestAgeMs: 5 }, false],
    [{ queued: 2, oldestAgeMs: 25.1 }, false],
    [{ queued: 2, oldestAgeMs: null }, false],
  ])("%p at 60 Hz → oldest: %p", (input, expected) => {
    expect(presentOldestFrame({ ...input, vsyncMs: VSYNC })).toBe(expected);
  });

  test("scales the age limit with the display interval", () => {
    // 120 Hz: 12.5 ms is 1.5 intervals.
    expect(presentOldestFrame({ queued: 2, oldestAgeMs: 12, vsyncMs: 1000 / 120 })).toBe(true);
    expect(presentOldestFrame({ queued: 2, oldestAgeMs: 13, vsyncMs: 1000 / 120 })).toBe(false);
  });
});

describe("VsyncEstimator", () => {
  test("assumes 60 Hz, then takes the shortest gap between callbacks", () => {
    const vsync = new VsyncEstimator();
    expect(vsync.intervalMs).toBeCloseTo(16.67, 1);
    // Callbacks are requested only when frames wait, so gaps span 1–3 vsyncs.
    for (const at of [0, 8.3, 25, 33.3, 41.7, 66.7]) vsync.observe(at);
    expect(vsync.intervalMs).toBeCloseTo(8.3, 1);
  });

  test("ignores pauses and impossible gaps", () => {
    const vsync = new VsyncEstimator();
    for (const at of [0, 1, 500, 516.7]) vsync.observe(at);
    expect(vsync.intervalMs).toBeCloseTo(16.7, 1);
  });
});

describe("the frame queue for pacing", () => {
  test("hands out the oldest frame and keeps the newer ones", () => {
    const resources = new StreamSessionResources<Frame, string>({ frameCapacity: 3 });
    const frames = [new Frame(1), new Frame(2)];
    for (const frame of frames) resources.pushFrame(frame);
    expect(resources.peekOldestFrame()).toBe(frames[0]!);
    expect(resources.takeOldestFrame()).toBe(frames[0]!);
    expect(resources.queuedFrameCount).toBe(1);
    expect(resources.peekOldestFrame()).toBe(frames[1]!);
    resources.pushFrame(new Frame(3));
    expect(resources.takeOldestFrame()?.timestamp).toBe(2);
    expect(resources.takeOldestFrame()?.timestamp).toBe(3);
    expect(resources.takeOldestFrame()).toBeNull();
    expect(frames.some((frame) => frame.closed)).toBe(false);
  });

  test("counts frames closed undrawn, but not a reset's", () => {
    const resources = new StreamSessionResources<Frame, string>({ frameCapacity: 3 });
    for (let timestamp = 1; timestamp <= 4; timestamp++) resources.pushFrame(new Frame(timestamp));
    // One overflow, then two superseded by the newest.
    expect(resources.takeLatestFrame()?.timestamp).toBe(4);
    expect(resources.takeSkippedFrames()).toBe(3);
    expect(resources.takeSkippedFrames()).toBe(0);
    resources.pushFrame(new Frame(5));
    resources.pushFrame(new Frame(6));
    resources.reset();
    expect(resources.takeSkippedFrames()).toBe(0);
  });
});

/**
 * Plays decode completion times through the worker's per-vsync choice and
 * reports what was drawn. `adaptive: false` is the old newest-only policy.
 */
function play(decodedAt: number[], adaptive: boolean, vsyncMs = VSYNC) {
  const resources = new StreamSessionResources<Frame, number>({ frameCapacity: 3 });
  const drawn: number[] = [];
  const addedLatency: number[] = [];
  let next = 0;
  const end = decodedAt.at(-1)! + 5 * vsyncMs;
  for (let now = vsyncMs; now <= end; now += vsyncMs) {
    while (next < decodedAt.length && decodedAt[next]! <= now) {
      resources.rememberTiming(next, decodedAt[next]!);
      resources.pushFrame(new Frame(next));
      next++;
    }
    const oldest = resources.peekOldestFrame();
    const oldestDecodedAt = oldest ? resources.peekTiming(oldest.timestamp)! : null;
    const useOldest =
      adaptive &&
      presentOldestFrame({
        queued: resources.queuedFrameCount,
        oldestAgeMs: oldestDecodedAt === null ? null : now - oldestDecodedAt,
        vsyncMs,
      });
    const frame = useOldest ? resources.takeOldestFrame() : resources.takeLatestFrame();
    if (!frame) continue;
    drawn.push(frame.timestamp);
    addedLatency.push(now - resources.takeTiming(frame.timestamp)!);
  }
  return {
    drawn,
    skipped: resources.takeSkippedFrames(),
    maxLatencyMs: Math.max(...addedLatency),
    lastLatencyMs: addedLatency.at(-1)!,
  };
}

/** Deterministic noise in [-1, 1], so runs are reproducible. */
function noise(index: number): number {
  return (((index * 7919) % 1009) / 1009) * 2 - 1;
}

describe("pacing with synthetic decode times", () => {
  test("a steady 60 fps source on 60 Hz: every frame is drawn either way", () => {
    const decodedAt = Array.from({ length: 600 }, (_, i) => i * VSYNC + 3);
    expect(play(decodedAt, false).skipped).toBe(0);
    expect(play(decodedAt, true)).toMatchObject({ skipped: 0 });
  });

  test("a jittery source near a vsync boundary: every frame drawn, at most one extra interval", () => {
    // Frames finish about 15 ms after a vsync, ±2.5 ms: now and then two
    // land within one display interval and the next interval gets none.
    const decodedAt = Array.from({ length: 600 }, (_, i) => i * VSYNC + 15 + 2.5 * noise(i));
    const newestOnly = play(decodedAt, false);
    const adaptive = play(decodedAt, true);
    expect(newestOnly.skipped).toBeGreaterThan(15);
    expect(adaptive.skipped).toBe(0);
    expect(adaptive.drawn).toHaveLength(600);
    expect(adaptive.maxLatencyMs).toBeLessThan(1.5 * VSYNC);
  });

  test("after a stall and a burst it skips to the newest frame at once", () => {
    // 200 ms with no output, then 12 frames at once, then steady again.
    const steady = (from: number, count: number, start: number) =>
      Array.from({ length: count }, (_, i) => start + (from + i) * VSYNC);
    const decodedAt = [
      ...steady(0, 30, 3),
      ...Array.from({ length: 12 }, () => 30 * VSYNC + 200),
      ...steady(42, 60, 200 + 3),
    ];
    const adaptive = play(decodedAt, true);
    // The burst collapses to its newest frame on the first vsync after it.
    const burst = Array.from({ length: 12 }, (_, i) => 30 + i);
    expect(adaptive.drawn.filter((index) => burst.includes(index))).toEqual([41]);
    expect(adaptive.lastLatencyMs).toBeLessThan(VSYNC);
  });
});
