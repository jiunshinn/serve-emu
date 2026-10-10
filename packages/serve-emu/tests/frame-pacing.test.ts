import { describe, expect, test } from "bun:test";
import {
  StreamSessionResources,
  type ClosableStreamFrame,
} from "../src/ui/lib/stream-lifecycle.ts";
import { nextPresentation, VsyncEstimator } from "../src/ui/lib/stream-performance.ts";

const VSYNC = 1000 / 60;

class Frame implements ClosableStreamFrame {
  closed = false;
  constructor(readonly timestamp: number) {}
  close(): void {
    this.closed = true;
  }
}

/**
 * One vsync over `queued` frames (timestamps 0, 1, …) at t = 100 ms, the
 * oldest decoded `ageMs` earlier and the others just now.
 */
function presentOnce(queued: number, ageMs: number | null, vsyncMs = VSYNC) {
  const resources = new StreamSessionResources<Frame, number | null>({ frameCapacity: 3 });
  for (let timestamp = 0; timestamp < queued; timestamp++) {
    resources.rememberTiming(timestamp, timestamp > 0 ? 100 : ageMs === null ? null : 100 - ageMs);
    resources.pushFrame(new Frame(timestamp));
  }
  const { frame, reschedule } = nextPresentation(
    resources,
    (oldest) => resources.peekTiming(oldest.timestamp) ?? null,
    100,
    vsyncMs,
  );
  return { frame: frame?.timestamp ?? null, reschedule, skipped: resources.takeSkippedFrames() };
}

describe("nextPresentation (#75)", () => {
  test.each([
    // Keeping up: the older of two, and the newer on the next vsync.
    [2, 10, { frame: 0, reschedule: true, skipped: 0 }],
    [2, 24.9, { frame: 0, reschedule: true, skipped: 0 }],
    [1, 5, { frame: 0, reschedule: false, skipped: 0 }],
    // Behind (a deeper queue, an older frame, or no age): the newest.
    [3, 5, { frame: 2, reschedule: false, skipped: 2 }],
    [2, 25.1, { frame: 1, reschedule: false, skipped: 1 }],
    [2, null, { frame: 1, reschedule: false, skipped: 1 }],
  ] as const)("%p queued, the oldest %p ms old, at 60 Hz → %p", (queued, ageMs, expected) => {
    expect(presentOnce(queued, ageMs)).toEqual(expected);
  });

  test("scales the age limit with the display interval", () => {
    // 120 Hz: 12.5 ms is 1.5 intervals.
    expect(presentOnce(2, 12, 1000 / 120).frame).toBe(0);
    expect(presentOnce(2, 13, 1000 / 120).frame).toBe(1);
  });

  test("an empty queue presents nothing", () => {
    expect(presentOnce(0, null)).toEqual({ frame: null, reschedule: false, skipped: 0 });
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

  test("forgets gaps older than 2 s, so a slower display shows", () => {
    const vsync = new VsyncEstimator();
    // 120 Hz, then the tab moves to a 60 Hz display and frames arrive only
    // now and then: far fewer than the 32-gap window, over more than 2 s.
    for (let at = 0; at <= 100; at += 1000 / 120) vsync.observe(at);
    expect(vsync.intervalMs).toBeCloseTo(8.3, 1);
    for (let at = 300; at <= 2_300; at += 250) {
      vsync.observe(at);
      vsync.observe(at + VSYNC);
    }
    expect(vsync.intervalMs).toBeCloseTo(16.7, 1);
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
    // Skips not yet reported when a generation ends are not the next one's.
    for (let timestamp = 7; timestamp <= 10; timestamp++) resources.pushFrame(new Frame(timestamp));
    resources.reset();
    expect(resources.takeSkippedFrames()).toBe(0);
  });
});

/**
 * Plays decode completion times through the worker's per-vsync choice and
 * reports what was drawn. Like the worker, a vsync is handled only when it
 * was requested: by a decoder output, or by the previous vsync keeping a
 * frame. `adaptive: false` is the old newest-only policy.
 */
function play(decodedAt: number[], adaptive: boolean, vsyncMs = VSYNC) {
  const resources = new StreamSessionResources<Frame, number>({ frameCapacity: 3 });
  const decodedAtOf = (frame: Frame) => resources.peekTiming(frame.timestamp) ?? null;
  const drawn: number[] = [];
  const addedLatency: number[] = [];
  let requested = false;
  let next = 0;
  const end = decodedAt.at(-1)! + 5 * vsyncMs;
  for (let now = vsyncMs; now <= end; now += vsyncMs) {
    while (next < decodedAt.length && decodedAt[next]! <= now) {
      resources.rememberTiming(next, decodedAt[next]!);
      resources.pushFrame(new Frame(next));
      requested = true;
      next++;
    }
    if (!requested) continue;
    const { frame, reschedule } = adaptive
      ? nextPresentation(resources, decodedAtOf, now, vsyncMs)
      : { frame: resources.takeLatestFrame(), reschedule: false };
    requested = reschedule;
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

  test("two frames in one vsync, then a static screen: both are drawn", () => {
    // Nothing follows the pair, so only the kept frame's own request can
    // bring the vsync that draws it.
    expect(play([3, 5], true)).toMatchObject({ drawn: [0, 1], skipped: 0 });
    expect(play([3, 5], false)).toMatchObject({ drawn: [1], skipped: 1 });
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
