/** Local elapsed times are independent of server/browser clock skew. */
const SAMPLE_CAPACITY = 256;
const MAX_DECODE_WAIT_MS = 250;
const HARD_DECODE_QUEUE_SIZE = 48;

class Samples {
  #values: number[] = [];
  #cursor = 0;
  add(value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    this.#values[this.#cursor] = value;
    this.#cursor = (this.#cursor + 1) % SAMPLE_CAPACITY;
  }
  takeP95(): number | null {
    const sorted = this.#values.sort((a, b) => a - b);
    const value = sorted.length
      ? sorted[Math.ceil(sorted.length * 0.95) - 1]!
      : null;
    this.#values = [];
    this.#cursor = 0;
    return value === null ? null : Math.round(value * 10) / 10;
  }
}

export type RecoveryAdmission =
  | { action: "decode"; endsDrop: boolean }
  | { action: "drop"; requestKeyframe: boolean }
  | { action: "recover" };

/**
 * Decides what an incoming packet does to a pipeline that may be recovering.
 *
 * While dropping until a keyframe, every dropped delta re-asks for one (the
 * request has its own cooldown), so a request lost to a cooldown or coalesced
 * by the server cannot leave the stream frozen until the encoder's next
 * periodic IDR. The keyframe that ends the drop is always decoded: it is the
 * frame recovery asked for, and holding it back because older work is still
 * queued would only start another drop.
 */
export function admitDuringRecovery(input: {
  dropping: boolean;
  isKey: boolean;
  decoderReady: boolean;
  backlogged: () => boolean;
}): RecoveryAdmission {
  if (input.dropping) {
    if (!input.isKey || !input.decoderReady) {
      return { action: "drop", requestKeyframe: true };
    }
    return { action: "decode", endsDrop: true };
  }
  if (!input.decoderReady) {
    return { action: "drop", requestKeyframe: !input.isKey };
  }
  if (input.backlogged()) return { action: "recover" };
  return { action: "decode", endsDrop: false };
}

/** The display interval assumed until vsync callbacks have been observed. */
const DEFAULT_VSYNC_MS = 1000 / 60;
const VSYNC_WINDOW = 32;
// Older gaps are forgotten, so a move to a slower display shows within 2 s.
const VSYNC_SAMPLE_MAX_AGE_MS = 2_000;

/**
 * Estimates the display's frame interval from animation-frame timestamps.
 * Callbacks are requested only when a frame is waiting, so a gap can span
 * several vsyncs; the shortest recent gap is one interval once callbacks
 * ran on consecutive vsyncs. On a fast display showing slower content they
 * rarely do, and the estimate is the content's interval instead, which only
 * makes presentOldestFrame stricter.
 */
export class VsyncEstimator {
  #last: number | null = null;
  #gaps: Array<{ at: number; gap: number }> = [];

  observe(timestampMs: number): void {
    if (!Number.isFinite(timestampMs)) return;
    if (this.#last !== null) {
      const gap = timestampMs - this.#last;
      // 4–50 ms covers 240 Hz through 20 Hz; anything else is a pause.
      if (gap >= 4 && gap <= 50) this.#gaps.push({ at: timestampMs, gap });
    }
    while (
      this.#gaps.length > VSYNC_WINDOW ||
      (this.#gaps.length > 0 &&
        timestampMs - this.#gaps[0]!.at > VSYNC_SAMPLE_MAX_AGE_MS)
    ) {
      this.#gaps.shift();
    }
    this.#last = timestampMs;
  }

  get intervalMs(): number {
    return this.#gaps.length
      ? Math.min(...this.#gaps.map(({ gap }) => gap))
      : DEFAULT_VSYNC_MS;
  }
}

/**
 * Adaptive pacing (#75): which decoded frame a vsync shows.
 *
 * Two frames that finish decoding within one display interval would cost
 * the older one under newest-only pacing (about 6% of a steady 60 fps
 * stream on a 60 Hz display). While the player keeps up (no more than two
 * frames queued, and the oldest decoded under 1.5 intervals ago), it shows
 * the oldest and keeps the next for the following vsync, which adds at most
 * one interval of latency. A deeper queue or an older frame means the
 * player fell behind, after a stall or a burst: it skips to the newest, as
 * before, so latency recovers at once.
 */
function presentOldestFrame(input: {
  queued: number;
  oldestAgeMs: number | null;
  vsyncMs: number;
}): boolean {
  return (
    input.queued === 2 &&
    input.oldestAgeMs !== null &&
    input.oldestAgeMs < 1.5 * input.vsyncMs
  );
}

/** The decoded-frame queue as a vsync reads it (StreamSessionResources). */
type PresentationQueue<Frame> = {
  readonly queuedFrameCount: number;
  peekOldestFrame(): Frame | null;
  takeOldestFrame(): Frame | null;
  takeLatestFrame(): Frame | null;
};

/**
 * One vsync's presentation (#75): the frame to draw, chosen by
 * presentOldestFrame, and whether a frame stays queued for the next vsync.
 * The caller must then request that vsync itself: on a static screen no
 * decoder output follows to request it, and the kept frame would wait until
 * the screen next changes.
 */
export function nextPresentation<Frame>(
  queue: PresentationQueue<Frame>,
  decodedAtOf: (frame: Frame) => number | null,
  nowMs: number,
  vsyncMs: number,
): { frame: Frame | null; reschedule: boolean } {
  const oldest = queue.peekOldestFrame();
  const decodedAt = oldest ? decodedAtOf(oldest) : null;
  const frame = presentOldestFrame({
    queued: queue.queuedFrameCount,
    oldestAgeMs: decodedAt === null ? null : nowMs - decodedAt,
    vsyncMs,
  })
    ? queue.takeOldestFrame()
    : queue.takeLatestFrame();
  return { frame, reschedule: frame !== null && queue.queuedFrameCount > 0 };
}

export class StreamPerformance {
  #pending = new Map<number, number>();
  #decode = new Samples();
  #present = new Samples();

  submitted(timestamp: number, now: number): void {
    if (this.#pending.size >= SAMPLE_CAPACITY)
      this.#pending.delete(this.#pending.keys().next().value!);
    this.#pending.set(timestamp, now);
  }
  decoded(timestamp: number, now: number): void {
    const submitted = this.#pending.get(timestamp);
    this.#pending.delete(timestamp);
    if (submitted !== undefined) this.#decode.add(now - submitted);
  }
  presented(decodedAt: number, now: number): void {
    this.#present.add(now - decodedAt);
  }
  pendingMs(now: number): number {
    const oldest = this.#pending.values().next().value;
    return oldest === undefined ? 0 : Math.max(0, now - oldest);
  }
  shouldRecover(queueSize: number, now: number): boolean {
    // A static source may leave output in a hardware pipeline while no decode
    // work is queued. That is not evidence of decoder overload.
    return (
      queueSize >= HARD_DECODE_QUEUE_SIZE ||
      (queueSize > 0 && this.pendingMs(now) > MAX_DECODE_WAIT_MS)
    );
  }
  takeStats() {
    return {
      decodeMsP95: this.#decode.takeP95(),
      presentMsP95: this.#present.takeP95(),
    };
  }
  reset(): void {
    this.#pending.clear();
    this.#decode = new Samples();
    this.#present = new Samples();
  }
}

/** Lowest-RTT sample in a rolling minute; one-way values remain estimates. */
type ClockSample = { at: number; offsetMs: number; uncertaintyMs: number };

export class StreamClockSync {
  #samples: ClockSample[] = [];
  observe(sentMs: number, receivedMs: number, serverMs: number): void {
    const rtt = receivedMs - sentMs;
    if (
      ![sentMs, receivedMs, serverMs].every(Number.isFinite) ||
      rtt < 0 ||
      rtt > 5000
    )
      return;
    this.#samples = this.#samples
      .filter((s) => receivedMs - s.at < 60_000)
      .slice(-11);
    this.#samples.push({
      at: receivedMs,
      offsetMs: serverMs - (sentMs + receivedMs) / 2,
      uncertaintyMs: rtt / 2,
    });
  }
  estimate(now: number) {
    return this.#samples
      .filter((s) => now - s.at < 60_000)
      .reduce<ClockSample | null>(
        (best, sample) =>
          !best || sample.uncertaintyMs < best.uncertaintyMs ? sample : best,
        null,
      );
  }
  elapsedSinceServer(serverMs: number, now: number): number | null {
    const sample = this.estimate(now);
    return sample ? Math.max(0, now + sample.offsetMs - serverMs) : null;
  }
  reset(): void {
    this.#samples = [];
  }
}
