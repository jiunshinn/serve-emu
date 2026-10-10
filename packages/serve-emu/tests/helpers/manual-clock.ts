/** One timer the clock handed out; tests may call a stale one's callback directly. */
export type ManualTimer = {
  kind: "timeout" | "interval";
  callback: () => void;
  dueMs: number;
  active: boolean;
};

/**
 * A clock whose time only moves when a test says so. It covers the clock
 * interfaces of the executor, upload manager, logcat hub, route playback, and
 * recovery watchdog, and the UI poll scheduler. Timeouts fire when due
 * (`tick`, `fireDue`) or all at once (`runTimeouts`); intervals fire only
 * through `fireActive`.
 */
export class ManualClock {
  nowMs: number;
  /** Every timer handed out, in creation order. */
  readonly timers: ManualTimer[] = [];
  /** The most intervals that were active at the same time. */
  maxActiveIntervals = 0;
  #cleared: ManualTimer[] = [];

  constructor(startMs = 0) {
    this.nowMs = startMs;
  }

  now = (): number => this.nowMs;

  setTimeout = (callback: () => void, delayMs = 0): ManualTimer =>
    this.#add("timeout", callback, delayMs);

  clearTimeout = (timer: unknown): void => {
    (timer as ManualTimer).active = false;
  };

  setInterval = (callback: () => void, delayMs = 0): ManualTimer => {
    const timer = this.#add("interval", callback, delayMs);
    this.maxActiveIntervals = Math.max(this.maxActiveIntervals, this.activeIntervals);
    return timer;
  };

  clearInterval = (timer: unknown): void => {
    const interval = timer as ManualTimer;
    if (interval.active) this.#cleared.push(interval);
    interval.active = false;
  };

  /** Moves time forward without firing anything. */
  advance(ms: number): void {
    this.nowMs += ms;
  }

  /**
   * Moves time forward, firing timeouts in due order as their time comes,
   * including ones that earlier callbacks schedule within the same span.
   * Each callback sees `now()` at its own due time.
   */
  tick(ms: number): void {
    const target = this.nowMs + ms;
    for (;;) {
      // Sorting is stable, so timeouts due together fire in creation order.
      const next = this.timers
        .filter((timer) => timer.kind === "timeout" && timer.active && timer.dueMs <= target)
        .sort((left, right) => left.dueMs - right.dueMs)[0];
      if (!next) break;
      next.active = false;
      this.nowMs = Math.max(this.nowMs, next.dueMs);
      next.callback();
    }
    this.nowMs = target;
  }

  /** Fires each active timeout whose due time has passed, once. */
  fireDue(): void {
    for (const timer of [...this.timers]) {
      if (timer.kind !== "timeout" || !timer.active || timer.dueMs > this.nowMs) continue;
      timer.active = false;
      timer.callback();
    }
  }

  /** Fires every pending timeout once, whatever its due time. */
  runTimeouts(): void {
    const pending = this.timers.filter((timer) => timer.kind === "timeout" && timer.active);
    for (const timer of pending) timer.active = false;
    for (const timer of pending) timer.callback();
  }

  /** Fires each active interval once. */
  fireActive(): void {
    for (const timer of [...this.timers]) {
      if (timer.kind === "interval" && timer.active) timer.callback();
    }
  }

  /** Fires the callbacks of intervals cleared since the last call (they should be inert). */
  fireCleared(): void {
    for (const timer of this.#cleared.splice(0)) timer.callback();
  }

  get activeIntervals(): number {
    return this.timers.filter((timer) => timer.kind === "interval" && timer.active).length;
  }

  get pendingTimeouts(): number {
    return this.timers.filter((timer) => timer.kind === "timeout" && timer.active).length;
  }

  #add(kind: ManualTimer["kind"], callback: () => void, delayMs: number): ManualTimer {
    const timer = { kind, callback, dueMs: this.nowMs + delayMs, active: true };
    this.timers.push(timer);
    return timer;
  }
}
