export type RecoveryClientState = {
  awaitingKeyFrame: boolean;
  awaitingKeyFrameSinceMs: number | null;
  lastKeyFrameRequestMs: number | null;
};

export type RecoveryWatchdogClock = {
  now(): number;
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(timer: unknown): void;
};

export const SYSTEM_RECOVERY_WATCHDOG_CLOCK: RecoveryWatchdogClock = {
  now: Date.now,
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (timer) =>
    clearInterval(timer as ReturnType<typeof setInterval>),
};

export type SessionRecoveryWatchdogOptions<
  TClient extends RecoveryClientState,
> = {
  clock?: RecoveryWatchdogClock;
  clients: () => Iterable<TClient>;
  requestReset: (reason: string, nowMs: number) => boolean;
  startedMs?: number;
  intervalMs?: number;
  sessionResetCooldownMs?: number;
  firstFrameResetMs?: number;
  sourceStallResetMs?: number;
  /** Cap for the stall threshold while stall resets keep finding an idle screen. */
  maxSourceStallResetMs?: number;
  /**
   * The longest run of frames that is still one change's burst (a frame plus
   * its repeats). A longer run means the screen keeps changing.
   */
  resetBurstFrames?: number;
  awaitingKeyFrameResetMs?: number;
  resetSettleMs?: number;
  maxResetSettleMs?: number;
};

/**
 * `idle`: no recent frames, but the encoder answers resets (a static screen).
 * `stalled`: no frame since a reset that had time to answer, or no first frame.
 */
export type SourceState = "starting" | "streaming" | "idle" | "stalled";

export type SessionRecoverySnapshot = {
  sourceState: SourceState;
  /** Quiet time after which the next stall reset is sent. */
  stallResetAfterMs: number;
  sourceFps: number;
  lastFrameMs: number | null;
  sourceFrameAgeMs: number;
  awaitingClients: number;
  oldestAwaitingAgeMs: number | null;
  lastResetAttemptMs: number | null;
  pendingResetAgeMs: number | null;
  resetBackoffMs: number;
};

const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_SESSION_RESET_COOLDOWN_MS = 500;
const DEFAULT_FIRST_FRAME_RESET_MS = 5_000;
const DEFAULT_SOURCE_STALL_RESET_MS = 2_500;
const DEFAULT_MAX_SOURCE_STALL_RESET_MS = 30_000;
// A restarted encoder sends its key frame, and on a static screen Android
// repeats a frame at most 10 more times, so each change (a restart, a status
// bar tick) arrives as a run of about 11 frames.
const DEFAULT_RESET_BURST_FRAMES = 16;
// Frames closer together than this belong to one run.
const FRAME_RUN_GAP_MS = 1_000;
const DEFAULT_AWAITING_KEYFRAME_RESET_MS = 2_500;
const DEFAULT_RESET_SETTLE_MS = 2_500;
const DEFAULT_MAX_RESET_SETTLE_MS = 30_000;

/**
 * Owns the timer and recovery timing for exactly one scrcpy session.
 *
 * The reset callback is synchronous on purpose: `true` means the reset was
 * admitted to the active session's writer. Every attempt consumes the
 * session-level cooldown so a throwing writer cannot create a hot loop, while
 * only admitted requests update clients' last-request timestamps.
 *
 * A reset restarts scrcpy's encoder, and the new session opens with a key
 * frame. Until that key frame arrives, further requests are coalesced into the
 * pending restart: issuing another reset would kill the encoder before it can
 * answer, which livelocks a slow device. The settle window doubles for each
 * reset that produces no frames at all, up to `maxResetSettleMs`.
 */
export class SessionRecoveryWatchdog<TClient extends RecoveryClientState> {
  readonly startedMs: number;

  #clock: RecoveryWatchdogClock;
  #clients: () => Iterable<TClient>;
  #requestReset: (reason: string, nowMs: number) => boolean;
  #intervalMs: number;
  #sessionResetCooldownMs: number;
  #firstFrameResetMs: number;
  #sourceStallResetMs: number;
  #maxSourceStallResetMs: number;
  #resetBurstFrames: number;
  #awaitingKeyFrameResetMs: number;
  #resetSettleMs: number;
  #maxResetSettleMs: number;
  #timer: unknown | null = null;
  #runEpoch = 0;
  #frameCount = 0;
  #lastFrameMs: number | null = null;
  #sourceFps = 0;
  #lastFpsFrameCount = 0;
  #lastFpsSampleMs: number;
  #lastSessionResetAttemptMs: number | null = null;
  #pendingResetSinceMs: number | null = null;
  #resetsWithoutFrame = 0;
  #idleStallResets = 0;
  #runFrames = 0;
  #unansweredResetSinceMs: number | null = null;

  constructor(options: SessionRecoveryWatchdogOptions<TClient>) {
    this.#clock = options.clock ?? SYSTEM_RECOVERY_WATCHDOG_CLOCK;
    this.#clients = options.clients;
    this.#requestReset = options.requestReset;
    this.startedMs = options.startedMs ?? this.#clock.now();
    this.#lastFpsSampleMs = this.startedMs;
    this.#intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#sessionResetCooldownMs =
      options.sessionResetCooldownMs ?? DEFAULT_SESSION_RESET_COOLDOWN_MS;
    this.#firstFrameResetMs =
      options.firstFrameResetMs ?? DEFAULT_FIRST_FRAME_RESET_MS;
    this.#sourceStallResetMs =
      options.sourceStallResetMs ?? DEFAULT_SOURCE_STALL_RESET_MS;
    this.#maxSourceStallResetMs =
      options.maxSourceStallResetMs ?? DEFAULT_MAX_SOURCE_STALL_RESET_MS;
    this.#resetBurstFrames =
      options.resetBurstFrames ?? DEFAULT_RESET_BURST_FRAMES;
    this.#awaitingKeyFrameResetMs =
      options.awaitingKeyFrameResetMs ??
      DEFAULT_AWAITING_KEYFRAME_RESET_MS;
    this.#resetSettleMs = options.resetSettleMs ?? DEFAULT_RESET_SETTLE_MS;
    this.#maxResetSettleMs =
      options.maxResetSettleMs ?? DEFAULT_MAX_RESET_SETTLE_MS;
  }

  get running(): boolean {
    return this.#timer !== null;
  }

  start(): void {
    if (this.#timer !== null) return;
    const epoch = ++this.#runEpoch;
    this.#timer = this.#clock.setInterval(() => {
      if (this.#timer === null || epoch !== this.#runEpoch) return;
      this.tick();
    }, this.#intervalMs);
  }

  stop(): void {
    if (this.#timer === null) return;
    this.#runEpoch++;
    this.#clock.clearInterval(this.#timer);
    this.#timer = null;
  }

  recordFrame(isKeyFrame = false): void {
    const now = this.#clock.now();
    this.#runFrames =
      this.#lastFrameMs !== null && now - this.#lastFrameMs < FRAME_RUN_GAP_MS
        ? this.#runFrames + 1
        : 1;
    this.#frameCount++;
    this.#lastFrameMs = now;
    this.#resetsWithoutFrame = 0;
    this.#unansweredResetSinceMs = null;
    if (isKeyFrame) this.#pendingResetSinceMs = null;
    // A run longer than one change's burst: the screen keeps changing, so a
    // stall is measured from the base threshold again. Occasional small
    // changes on an idle screen (a clock tick) keep the backoff.
    if (this.#runFrames > this.#resetBurstFrames) this.#idleStallResets = 0;
  }

  markAwaiting(client: TClient): void {
    if (!client.awaitingKeyFrame) {
      client.awaitingKeyFrame = true;
      client.lastKeyFrameRequestMs = null;
    }
    if (client.awaitingKeyFrameSinceMs === null) {
      client.awaitingKeyFrameSinceMs = this.#clock.now();
    }
  }

  keyFrameAccepted(client: TClient): void {
    if (!client.awaitingKeyFrame) return;
    client.awaitingKeyFrame = false;
    client.awaitingKeyFrameSinceMs = null;
    client.lastKeyFrameRequestMs = null;
  }

  /**
   * True when neither the session cooldown nor a restart that is still
   * waiting for its key frame blocks another reset.
   */
  canRequestReset(nowMs = this.#clock.now()): boolean {
    if (
      this.#lastSessionResetAttemptMs !== null &&
      nowMs - this.#lastSessionResetAttemptMs < this.#sessionResetCooldownMs
    ) {
      return false;
    }
    return (
      this.#pendingResetSinceMs === null ||
      nowMs - this.#pendingResetSinceMs >= this.#resetSettleWindowMs()
    );
  }

  /**
   * Records an admitted reset. Callers that write the reset packet themselves
   * use this to share the pending-restart gate.
   */
  noteResetAdmitted(nowMs = this.#clock.now()): void {
    this.#lastSessionResetAttemptMs = nowMs;
    this.#pendingResetSinceMs = nowMs;
    this.#unansweredResetSinceMs ??= nowMs;
    this.#resetsWithoutFrame++;
    for (const client of this.#clients()) {
      if (client.awaitingKeyFrame) client.lastKeyFrameRequestMs = nowMs;
    }
  }

  requestVideoReset(reason: string): boolean {
    const now = this.#clock.now();
    if (!this.canRequestReset(now)) return false;

    this.#lastSessionResetAttemptMs = now;
    let admitted = false;
    try {
      admitted = this.#requestReset(reason, now);
    } catch {
      return false;
    }
    if (!admitted) return false;

    this.noteResetAdmitted(now);
    return true;
  }

  #stallResetAfterMs(): number {
    const doublings = Math.min(this.#idleStallResets, 16);
    return Math.max(
      this.#sourceStallResetMs,
      Math.min(
        this.#sourceStallResetMs * 2 ** doublings,
        this.#maxSourceStallResetMs,
      ),
    );
  }

  #sourceState(nowMs: number): SourceState {
    if (this.#lastFrameMs === null) {
      return nowMs - this.startedMs >= this.#firstFrameResetMs
        ? "stalled"
        : "starting";
    }
    // Measured from the first reset without an answer, so later retries do
    // not make a dead source look idle again.
    if (
      this.#unansweredResetSinceMs !== null &&
      nowMs - this.#unansweredResetSinceMs >= this.#resetSettleMs
    ) {
      return "stalled";
    }
    return nowMs - this.#lastFrameMs < this.#sourceStallResetMs
      ? "streaming"
      : "idle";
  }

  #resetSettleWindowMs(): number {
    const doublings = Math.min(Math.max(this.#resetsWithoutFrame, 1) - 1, 16);
    return Math.min(this.#resetSettleMs * 2 ** doublings, this.#maxResetSettleMs);
  }

  tick(): void {
    const now = this.#clock.now();
    const elapsedMs = now - this.#lastFpsSampleMs;
    if (elapsedMs > 0) {
      const elapsedFrames = this.#frameCount - this.#lastFpsFrameCount;
      this.#sourceFps = (elapsedFrames * 1_000) / elapsedMs;
      this.#lastFpsFrameCount = this.#frameCount;
      this.#lastFpsSampleMs = now;
    }

    const clients = Array.from(this.#clients());
    if (clients.length === 0) return;

    if (
      this.#frameCount === 0 &&
      now - this.startedMs >= this.#firstFrameResetMs
    ) {
      this.requestVideoReset("first video frame not received");
    } else if (this.#lastFrameMs !== null) {
      // A static screen answers a restart with only its burst, then goes quiet
      // again (#165). While the encoder keeps answering, each check doubles
      // the wait for the next one, until a longer run of frames shows the
      // screen is changing. Input is deliberately not a signal: an action
      // that changes nothing on screen sends no frame either, and agents
      // repeat such actions. A source that did not answer its last reset is
      // not idle: its retries follow the no-frame settle backoff instead.
      const idleProbe = this.#resetsWithoutFrame === 0;
      if (
        now - this.#lastFrameMs >= this.#stallResetAfterMs() &&
        this.requestVideoReset(
          idleProbe && this.#idleStallResets > 0
            ? "video source idle"
            : "video source stalled",
        ) &&
        idleProbe
      ) {
        this.#idleStallResets++;
      }
    }

    const awaitingRetry = clients.some((client) => {
      if (
        !client.awaitingKeyFrame ||
        client.awaitingKeyFrameSinceMs === null
      ) {
        return false;
      }
      const retryFrom =
        client.lastKeyFrameRequestMs ?? client.awaitingKeyFrameSinceMs;
      return now - retryFrom >= this.#awaitingKeyFrameResetMs;
    });
    if (awaitingRetry) {
      this.requestVideoReset("client awaiting keyframe");
    }
  }

  snapshot(nowMs = this.#clock.now()): SessionRecoverySnapshot {
    let awaitingClients = 0;
    let oldestAwaitingAgeMs: number | null = null;
    for (const client of this.#clients()) {
      if (
        !client.awaitingKeyFrame ||
        client.awaitingKeyFrameSinceMs === null
      ) {
        continue;
      }
      awaitingClients++;
      const ageMs = Math.max(0, nowMs - client.awaitingKeyFrameSinceMs);
      oldestAwaitingAgeMs = Math.max(oldestAwaitingAgeMs ?? 0, ageMs);
    }

    return {
      sourceState: this.#sourceState(nowMs),
      stallResetAfterMs: this.#stallResetAfterMs(),
      sourceFps: this.#sourceFps,
      lastFrameMs: this.#lastFrameMs,
      sourceFrameAgeMs: Math.max(
        0,
        nowMs - (this.#lastFrameMs ?? this.startedMs),
      ),
      awaitingClients,
      oldestAwaitingAgeMs,
      lastResetAttemptMs: this.#lastSessionResetAttemptMs,
      pendingResetAgeMs:
        this.#pendingResetSinceMs === null
          ? null
          : Math.max(0, nowMs - this.#pendingResetSinceMs),
      resetBackoffMs: this.#resetSettleWindowMs(),
    };
  }
}
