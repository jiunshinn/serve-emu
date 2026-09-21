import { describe, expect, test } from "bun:test";
import {
  StreamPerformance,
  StreamClockSync,
} from "../src/ui/lib/stream-performance.ts";

describe("decoder latency budget", () => {
  test("recovers a low-FPS queue by elapsed time, without resetting an idle hardware pipeline", () => {
    const tracker = new StreamPerformance();
    tracker.submitted(0, 0);
    tracker.submitted(66_667, 67);
    expect(tracker.shouldRecover(2, 250)).toBe(false);
    expect(tracker.shouldRecover(2, 251)).toBe(true);
    expect(tracker.shouldRecover(0, 5000)).toBe(false);
    expect(tracker.shouldRecover(48, 1)).toBe(true);
    tracker.decoded(0, 100);
    expect(tracker.pendingMs(300)).toBe(233);
    tracker.decoded(66_667, 200);
    expect(tracker.pendingMs(300)).toBe(0);
  });

  test("reports bounded p95 samples and resets them with each statistics interval", () => {
    const tracker = new StreamPerformance();
    for (let i = 1; i <= 100; i++) {
      tracker.submitted(i, 100);
      tracker.decoded(i, 100 + i);
      tracker.presented(100, 100 + i * 2);
    }
    expect(tracker.takeStats()).toEqual({ decodeMsP95: 95, presentMsP95: 190 });
    expect(tracker.takeStats()).toEqual({
      decodeMsP95: null,
      presentMsP95: null,
    });
    tracker.submitted(101, 0);
    tracker.reset();
    tracker.decoded(101, 1000);
    expect(tracker.takeStats().decodeMsP95).toBeNull();
    expect(tracker.pendingMs(1000)).toBe(0);
  });

  test("bounds pending timestamps and sample retention even without decoder output", () => {
    const tracker = new StreamPerformance();
    for (let i = 0; i < 1000; i++) tracker.submitted(i, i);
    expect(tracker.pendingMs(1000)).toBe(256);
    tracker.presented(10, 1);
    tracker.presented(0, Number.NaN);
    for (let i = 0; i < 1000; i++) tracker.presented(0, i);
    expect(tracker.takeStats().presentMsP95).toBe(987);
  });
});

describe("stream clock synchronization", () => {
  test("corrects positive and negative server clock offsets and exposes uncertainty", () => {
    for (const skew of [-60_000, 60_000]) {
      const sync = new StreamClockSync();
      expect(sync.elapsedSinceServer(0, 100)).toBeNull();
      sync.observe(100_000, 100_020, 100_010 + skew);
      expect(sync.estimate(100_020)).toMatchObject({
        offsetMs: skew,
        uncertaintyMs: 10,
      });
      expect(sync.elapsedSinceServer(100_100 + skew, 100_140)).toBe(40);
    }
  });

  test("uses the lowest RTT, expires old samples, and rejects malformed measurements", () => {
    const sync = new StreamClockSync();
    sync.observe(1000, 1020, 3010);
    sync.observe(2000, 2100, 4090);
    expect(sync.estimate(2100)?.offsetMs).toBe(2000);
    expect(sync.elapsedSinceServer(9999, 2100)).toBe(0);
    sync.observe(2, 1, 1);
    sync.observe(0, 9999, 1);
    sync.observe(Number.NaN, 1, 1);
    expect(sync.estimate(61_020)?.uncertaintyMs).toBe(50);
    expect(sync.estimate(62_100)).toBeNull();
    sync.reset();
    expect(sync.estimate(0)).toBeNull();
  });
});
