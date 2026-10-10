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
