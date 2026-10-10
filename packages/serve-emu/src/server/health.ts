import type { ExecSnapshot } from "../exec.ts";
import type { HealthResponse } from "../shared/api-contracts.ts";
import type { JsonResponseMetric } from "../json-response.ts";
import type { SessionRecoverySnapshot } from "../session-recovery-watchdog.ts";
import type { UploadManagerSnapshot } from "../upload-manager.ts";
import type { DeviceContext } from "./types.ts";

export type HealthSources = {
  nowMs: number;
  /** The context's recovery watchdog snapshot; null until a watchdog exists. */
  recovery: SessionRecoverySnapshot | null;
  /** Reported as the reset backoff while there is no watchdog yet. */
  idleResetBackoffMs: number;
  /** Reported as the stall threshold while there is no watchdog yet. */
  baseStallResetMs: number;
  responseMetrics: Record<string, JsonResponseMetric>;
  uploads: UploadManagerSnapshot;
  executor: ExecSnapshot;
};

/** The `/health` body for one device session: a pure read of its state. */
export function buildHealthSnapshot(context: DeviceContext, sources: HealthSources) {
  const now = sources.nowMs;
  const recoverySnapshot: SessionRecoverySnapshot = sources.recovery ?? {
    sourceState: "starting",
    stallResetAfterMs: sources.baseStallResetMs,
    sourceFps: 0,
    lastFrameMs: null,
    sourceFrameAgeMs: Math.max(0, now - context.startedMs),
    awaitingClients: 0,
    oldestAwaitingAgeMs: null,
    lastResetAttemptMs: null,
    pendingResetAgeMs: null,
    resetBackoffMs: sources.idleResetBackoffMs,
  };
  const snapshot = {
    ok: context.status === "streaming",
    status: context.status,
    generation: context.generation,
    serial: context.serial,
    device: context.scrcpy.meta.deviceName,
    codec: context.scrcpy.meta.codecId,
    size: { width: context.screen.width, height: context.screen.height },
    clients: context.clients.size,
    frames: context.frameCount,
    sourceFps: recoverySnapshot.sourceFps,
    sourceFrameAgeMs: recoverySnapshot.sourceFrameAgeMs,
    sourceState: recoverySnapshot.sourceState,
    keyFrameRecovery: {
      awaitingClients: recoverySnapshot.awaitingClients,
      oldestAwaitingAgeMs: recoverySnapshot.oldestAwaitingAgeMs,
      lastResetAttemptAt:
        recoverySnapshot.lastResetAttemptMs === null
          ? null
          : new Date(recoverySnapshot.lastResetAttemptMs).toISOString(),
      pendingResetAgeMs: recoverySnapshot.pendingResetAgeMs,
      resetBackoffMs: recoverySnapshot.resetBackoffMs,
      stallResetAfterMs: recoverySnapshot.stallResetAfterMs,
    },
    frameStats: context.frameStats.summary(),
    configPackets: context.configPacketCount,
    droppedFrames: context.totalDroppedFrames,
    backpressureEvents: context.totalBackpressureEvents,
    videoResetRequests: context.videoResetRequests,
    lastVideoResetAt: context.lastVideoResetAt,
    lastVideoResetReason: context.lastVideoResetReason,
    videoResetsByReason: { ...context.videoResetsByReason },
    videoResetsLastMinute: context.recentVideoResets(now),
    contention: context.contention,
    location: context.lastLocation,
    route: context.route.snapshot(),
    session: context.recorder.summary(),
    responseMetrics: sources.responseMetrics,
    logcat: context.logcat.snapshot(),
    uploads: sources.uploads,
    executor: sources.executor,
    clientsDetail: Array.from(context.clients, (client) => ({
      id: client.id,
      frameMeta: client.frameMeta,
      sentFrames: client.sentFrames,
      droppedFrames: client.droppedFrames,
      backpressureEvents: client.backpressureEvents,
      bufferedBytes: client.ws.getBufferedAmount(),
      awaitingKeyFrame: client.awaitingKeyFrame,
      awaitingKeyFrameSinceAt:
        client.awaitingKeyFrameSinceMs === null
          ? null
          : new Date(client.awaitingKeyFrameSinceMs).toISOString(),
      awaitingKeyFrameAgeMs:
        client.awaitingKeyFrameSinceMs === null
          ? null
          : Math.max(0, now - client.awaitingKeyFrameSinceMs),
      lastKeyFrameRequestAt:
        client.lastKeyFrameRequestMs === null
          ? null
          : new Date(client.lastKeyFrameRequestMs).toISOString(),
    })),
    startedAt: context.startedAt,
    stoppedAt: context.stoppedAt,
    lastFrameAt:
      recoverySnapshot.lastFrameMs === null
        ? null
        : new Date(recoverySnapshot.lastFrameMs).toISOString(),
    lastError: context.lastError,
    lastErrorCode: context.lastErrorCode,
    lastErrorMeta: context.lastErrorMeta,
  };
  // Extra diagnostics are fine; every field the UI contract parses must be here.
  snapshot satisfies HealthResponse;
  return snapshot;
}
