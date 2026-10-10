import type { DeviceSessionManager } from "../device-session-context.ts";
import { resetVideoPacket } from "../input.ts";
import { ScrcpyStreamError } from "../scrcpy.ts";
import {
  SessionRecoveryWatchdog,
  type RecoveryWatchdogClock,
} from "../session-recovery-watchdog.ts";
import {
  isAbnormalExit,
  procExitDetail,
  terminalTransitionAllowed,
  type SessionStatus,
} from "../session-status.ts";
import {
  epochNowMs,
  FRAME_META_HEADER_BYTES,
  writeFrameMetaHeader,
} from "../shared/frame-meta.ts";
import {
  frameDeliveryDecision,
  sendResultDecision,
} from "./backpressure.ts";
import type { Client, DeviceContext } from "./types.ts";
import { sendJson } from "./ws.ts";

const DROP_FRAME_BUFFERED_BYTES = 512 * 1024;
const CLOSE_CLIENT_BUFFERED_BYTES = 16 * 1024 * 1024;
const VIDEO_RESET_COOLDOWN_MS = 500;
const FIRST_FRAME_RESET_MS = 5000;
export const SOURCE_STALL_RESET_MS = 2500;
const AWAITING_KEYFRAME_RESET_MS = 2500;
export const RESET_SETTLE_MS = 2500;
const MAX_RESET_SETTLE_MS = 30_000;

function withFrameMeta(
  frameData: Buffer,
  frame: { pts: bigint; isKey: boolean },
  config: Buffer | null,
): Buffer {
  const configBytes = config?.length ?? 0;
  const out = Buffer.allocUnsafe(
    FRAME_META_HEADER_BYTES + configBytes + frameData.length,
  );
  writeFrameMetaHeader(out, {
    isKey: frame.isKey,
    pts: frame.pts,
    serverTsMs: epochNowMs(),
  });
  if (config) config.copy(out, FRAME_META_HEADER_BYTES);
  frameData.copy(out, FRAME_META_HEADER_BYTES + configBytes);
  return out;
}

function withConfig(frameData: Buffer, config: Buffer | null): Buffer {
  if (!config) return frameData;
  const out = Buffer.allocUnsafe(config.length + frameData.length);
  config.copy(out, 0);
  frameData.copy(out, config.length);
  return out;
}

/**
 * A device session's stream once it is activated: the frame pump that reads
 * scrcpy, frame delivery with backpressure, the recovery watchdog that asks
 * the encoder for key frames, and the terminal transitions when scrcpy ends.
 */
export function createVideoPipeline(deps: {
  sessions: DeviceSessionManager<DeviceContext>;
  clock: RecoveryWatchdogClock;
  /** True once the server is stopping; scrcpy endings are then expected. */
  isStopping: () => boolean;
}) {
  const { sessions, clock, isStopping } = deps;
  const recoveries = new WeakMap<
    DeviceContext,
    SessionRecoveryWatchdog<Client>
  >();

  const markTerminal = (
    context: DeviceContext,
    nextStatus: Exclude<SessionStatus, "streaming">,
    reason: string,
    detail?: { code?: string; meta?: Record<string, string | number> | null },
  ) => {
    if (sessions.current !== context) return;
    if (!terminalTransitionAllowed(context.status, nextStatus)) return;
    context.terminalTransitionStarted = true;
    context.status = nextStatus;
    context.lastError = reason;
    context.lastErrorCode = detail?.code ?? null;
    context.lastErrorMeta = detail?.meta ?? null;
    void context.dispose(reason, {
      status: nextStatus,
      clientCode: nextStatus === "error" ? 1011 : 1000,
    });
  };

  const enqueueVideoReset = (context: DeviceContext, reason: string) => {
    sessions.assertCurrent(context);
    context.inputQueue.assertOpen();
    const now = clock.now();
    // Client requests share the watchdog's gate, so they cannot restart an
    // encoder whose key frame is still on its way.
    const recovery = recoveries.get(context);
    const blocked = recovery
      ? !recovery.canRequestReset(now)
      : now - context.lastVideoResetMs < VIDEO_RESET_COOLDOWN_MS;
    if (blocked) {
      return { completion: Promise.resolve({ status: "coalesced" as const }) };
    }
    // Priority: a reset must not wait behind a long swipe (the next step
    // boundary is at most ~20 ms away), and it is excluded from the depth
    // limit so a full gesture queue cannot block it.
    const accepted = context.inputQueue.enqueuePacket(resetVideoPacket(), {
      coalesceKey: "reset-video",
      priority: true,
    });
    recovery?.noteResetAdmitted(now);
    context.lastVideoResetMs = now;
    context.videoResetRequests++;
    context.lastVideoResetAt = new Date(now).toISOString();
    context.lastVideoResetReason = reason;
    return accepted;
  };

  const createRecovery = (context: DeviceContext) =>
    new SessionRecoveryWatchdog<Client>({
      clock,
      clients: () => context.clients,
      startedMs: clock.now(),
      intervalMs: 1_000,
      sessionResetCooldownMs: VIDEO_RESET_COOLDOWN_MS,
      firstFrameResetMs: FIRST_FRAME_RESET_MS,
      sourceStallResetMs: SOURCE_STALL_RESET_MS,
      awaitingKeyFrameResetMs: AWAITING_KEYFRAME_RESET_MS,
      resetSettleMs: RESET_SETTLE_MS,
      maxResetSettleMs: MAX_RESET_SETTLE_MS,
      requestReset: (reason, now) => {
        if (!sessions.isCurrent(context) || context.status !== "streaming") {
          return false;
        }
        try {
          const accepted = context.inputQueue.enqueuePacket(
            resetVideoPacket(),
            { coalesceKey: "reset-video", priority: true },
          );
          void accepted.completion.catch(() => {});
          context.lastVideoResetMs = now;
          context.videoResetRequests++;
          context.lastVideoResetAt = new Date(now).toISOString();
          context.lastVideoResetReason = reason;
          return true;
        } catch {
          return false;
        }
      },
    });

  const dropUntilKeyFrame = (client: Client) => {
    client.droppedFrames++;
    client.context.totalDroppedFrames++;
    const recovery = recoveries.get(client.context);
    recovery?.markAwaiting(client);
    recovery?.requestVideoReset("client backpressure");
  };

  const sendFrame = (
    client: Client,
    data: () => Buffer,
    isKeyFrame: boolean,
  ) => {
    const decision = frameDeliveryDecision({
      awaitingKeyFrame: client.awaitingKeyFrame,
      isKeyFrame,
      bufferedBytes: client.ws.getBufferedAmount(),
      dropThresholdBytes: DROP_FRAME_BUFFERED_BYTES,
      closeThresholdBytes: CLOSE_CLIENT_BUFFERED_BYTES,
    });
    if (decision === "drop-awaiting-keyframe") {
      client.droppedFrames++;
      client.context.totalDroppedFrames++;
      return;
    }
    if (decision === "close-slow-client") {
      client.context.clients.delete(client);
      try {
        client.ws.close(1013, "client too slow");
      } catch {}
      return;
    }
    if (decision === "drop-buffered") {
      dropUntilKeyFrame(client);
      return;
    }
    let sent: number;
    try {
      sent = client.ws.send(data());
    } catch {
      client.context.clients.delete(client);
      try {
        client.ws.close(1011, "frame send failed");
      } catch {}
      return;
    }
    if (sendResultDecision(sent) === "backpressure") {
      client.backpressureEvents++;
      client.context.totalBackpressureEvents++;
      dropUntilKeyFrame(client);
      return;
    }
    if (sendResultDecision(sent) === "closed") {
      client.context.clients.delete(client);
      return;
    }
    client.sentFrames++;
    if (isKeyFrame) recoveries.get(client.context)?.keyFrameAccepted(client);
  };
  const startFramePump = (context: DeviceContext) => {
    context.cachedConfig = null;
    const pump = (async () => {
      try {
        while (!isStopping() && sessions.isCurrent(context)) {
          const f = await context.scrcpy.readFrame();
          if (!sessions.isCurrent(context)) break;
          if (!f) {
            if (!isStopping())
              markTerminal(context, "stopped", "scrcpy video stream ended");
            break;
          }
          if (f.type === "session") {
            if (f.width > 0 && f.height > 0) {
              context.screen.width = f.width;
              context.screen.height = f.height;
              context.cachedConfig = null;
              // A new encoder session always opens with codec config and a
              // key frame. Requesting a reset here would restart the encoder
              // before it can send that key frame.
              for (const c of context.clients) {
                recoveries.get(context)?.markAwaiting(c);
                sendJson(c.ws, {
                  type: "video-session",
                  size: { width: f.width, height: f.height },
                });
              }
            }
            continue;
          }
          if (f.isConfig) {
            context.cachedConfig = f.data;
            context.configPacketCount++;
            continue;
          }
          context.frameCount++;
          recoveries.get(context)?.recordFrame(f.isKey);
          context.frameStats.record(f.data.length, f.isKey);
          const config = f.isKey ? context.cachedConfig : null;
          let rawOut: Buffer | null = null;
          let framedOut: Buffer | null = null;
          for (const c of context.clients) {
            sendFrame(
              c,
              () =>
                c.frameMeta
                  ? (framedOut ??= withFrameMeta(f.data, f, config))
                  : (rawOut ??= withConfig(f.data, config)),
              f.isKey,
            );
          }
        }
      } catch (err) {
        if (
          isStopping() ||
          (context.signal.aborted && !context.terminalTransitionStarted)
        ) {
          return;
        }
        if (err instanceof ScrcpyStreamError) {
          markTerminal(context, "error", err.message, {
            code: err.code,
            meta: err.meta ?? null,
          });
        } else {
          markTerminal(context, "error", String(err));
        }
      }
    })();
    void context.trackDrain(pump).catch(() => {});
  };

  const attachSessionHandlers = (context: DeviceContext) => {
    context.scrcpy.proc.once("exit", (code, signal) => {
      // An abnormal exit (non-zero code or killed by signal) means scrcpy died
      // unexpectedly — classify it as "error" even if the video socket already
      // ended cleanly and marked the session "stopped" (markTerminal escalates).
      // Normal exits and server-initiated teardowns (the server stopping / a bumped
      // generation) are left alone.
      if (
        isStopping() ||
        sessions.current !== context ||
        (context.signal.aborted && !context.terminalTransitionStarted)
      ) {
        return;
      }
      if (!isAbnormalExit(code, signal)) return;
      const { reason, ...detail } = procExitDetail(code, signal);
      markTerminal(context, "error", reason, detail);
    });
    context.scrcpy.controlSocket.once("error", (err) => {
      if (
        !isStopping() &&
        sessions.current === context &&
        (!context.signal.aborted || context.terminalTransitionStarted)
      ) {
        markTerminal(
          context,
          "error",
          `scrcpy control socket error: ${err.message}`,
        );
      }
    });
  };

  const activateContext = (context: DeviceContext) => {
    const recovery = createRecovery(context);
    recoveries.set(context, recovery);
    context.registerCleanup(() => recovery.stop());
    startFramePump(context);
    attachSessionHandlers(context);
    recovery.start();
  };

  return {
    activate: activateContext,
    enqueueVideoReset,
    recovery: (context: DeviceContext) => recoveries.get(context),
  };
}
