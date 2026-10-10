import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import {
  ControlInputError,
  type ControlInputHandle,
  type ControlPacketHandle,
} from "../control-input-queue.ts";
import type { DeviceSessionManager } from "../device-session-context.ts";
import type { Gesture } from "../input.ts";
import type { SessionRecoveryWatchdog } from "../session-recovery-watchdog.ts";
import { shouldRecordPayload } from "../session-api.ts";
import { epochNowMs } from "../shared/frame-meta.ts";
import {
  parseWsClientMessage,
  parseWsRequestId,
} from "../shared/websocket-contracts.ts";
import type { Client, DeviceContext, WsData } from "./types.ts";

const MAX_WS_MESSAGE_BYTES = 16 * 1024;

export function sendJson(ws: ServerWebSocket<WsData>, value: unknown) {
  try {
    ws.send(JSON.stringify(value));
  } catch {}
}

function wantsAck(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return true;
  return (value as Record<string, unknown>).ack !== false;
}

// WebSocket replies keep their own contract (see websocket-contracts.ts).
function inputErrorPayload(err: unknown, status: "rejected" | "failed") {
  return {
    ok: false as const,
    status,
    ...(err instanceof ControlInputError ? { code: err.code } : {}),
    error: err instanceof Error ? err.message : String(err),
  };
}

/**
 * The `/ws` endpoint: the upgrade, then each client's control messages
 * (gestures, key frame requests, clock sync) and its touch release on close.
 */
export function createWebSocketEndpoint(deps: {
  sessions: DeviceSessionManager<DeviceContext>;
  recovery: (
    context: DeviceContext,
  ) => SessionRecoveryWatchdog<Client> | undefined;
  enqueueGesture: (
    context: DeviceContext,
    gesture: Gesture,
    source: string,
    record?: boolean,
  ) => ControlInputHandle;
  enqueueVideoReset: (
    context: DeviceContext,
    reason: string,
  ) => ControlPacketHandle;
  /** The body of the 503 an upgrade gets while the session is not streaming. */
  health: (context: DeviceContext) => unknown;
}) {
  const { sessions, recovery, enqueueGesture, enqueueVideoReset, health } =
    deps;
  let nextId = 1;
  let nextTouchId = 1;

  const enqueueClientGesture = (
    ws: ServerWebSocket<WsData>,
    gesture: Gesture,
    recordRequested: boolean,
  ) => {
    const client = ws.data.handle;
    if (gesture.type !== "touch")
      return enqueueGesture(ws.data.context, gesture, "ws", recordRequested);
    if (!client) throw new Error("WebSocket client is not open");
    const sourceId = gesture.pointerId ?? 0;
    const previous = client.touches.get(sourceId);
    if (gesture.action === "down" ? previous : !previous) {
      throw new Error(
        gesture.action === "down"
          ? "pointer is already down"
          : "pointer is not down",
      );
    }
    if (!previous && !Number.isSafeInteger(nextTouchId))
      throw new Error("pointer id space exhausted");
    const mapped = {
      ...gesture,
      pointerId: previous?.gesture.pointerId ?? nextTouchId++,
    };
    // Recording is decided once per pointer, at its down: the pointer's moves,
    // its up, and a disconnect release all follow that decision, so a session
    // never holds a down without its up (or an up without its down).
    const record = previous ? previous.record : recordRequested;
    const accepted = enqueueGesture(ws.data.context, mapped, "ws", record);
    if (gesture.action === "up") client.touches.delete(sourceId);
    else client.touches.set(sourceId, { gesture: mapped, record });
    return accepted;
  };

  const releaseClientTouches = (client: Client) => {
    // The input queue reserves an UP slot for every admitted DOWN, even when full.
    // Never redirect a late disconnect's releases onto a replacement session.
    if (sessions.isCurrent(client.context)) {
      for (const { gesture, record } of client.touches.values()) {
        try {
          const accepted = enqueueGesture(
            client.context,
            { ...gesture, action: "up" },
            "ws:disconnect",
            record,
          );
          void accepted.completion.catch(() => {});
        } catch {}
      }
    }
    client.touches.clear();
  };

  const handlers: WebSocketHandler<WsData> = {
    maxPayloadLength: MAX_WS_MESSAGE_BYTES,
    open(ws) {
      const context = ws.data.context;
      if (!sessions.isCurrent(context)) {
        sendJson(ws, {
          ok: false,
          code: "session_changed",
          error: "device session changed",
        });
        ws.close(1012, "device session changed");
        return;
      }
      const handle: Client = {
        touches: new Map(),
        id: ws.data.id,
        ws,
        context,
        frameMeta: ws.data.frameMeta,
        sentFrames: 0,
        droppedFrames: 0,
        backpressureEvents: 0,
        awaitingKeyFrame: false,
        awaitingKeyFrameSinceMs: null,
        lastKeyFrameRequestMs: null,
      };
      context.clients.add(handle);
      ws.data.handle = handle;
      const watchdog = recovery(context);
      watchdog?.markAwaiting(handle);
      watchdog?.requestVideoReset("client opened");
    },
    message(ws, raw) {
      const context = ws.data.context;
      if (!sessions.isCurrent(context)) {
        ws.close(1012, "device session changed");
        return;
      }
      if (typeof raw !== "string") return;
      if (raw.length > MAX_WS_MESSAGE_BYTES) {
        ws.close(1009, "message too large");
        return;
      }
      let acknowledge = true;
      let requestId: string | undefined;
      const reply = (value: Record<string, unknown>) =>
        sendJson(ws, {
          ...value,
          ...(requestId === undefined ? {} : { requestId }),
        });
      try {
        const payload = JSON.parse(raw);
        acknowledge = wantsAck(payload);
        requestId = parseWsRequestId(payload?.requestId);
        // Checked after the request id is known so the error reply carries it.
        if (context.status !== "streaming") {
          throw new Error(`session is ${context.status}`);
        }
        const msg = parseWsClientMessage(payload);
        if (msg.type === "clock-sync") {
          reply({ type: "clock-sync", clientTsMs: msg.clientTsMs, serverTsMs: epochNowMs() });
          return;
        }
        if (msg.type === "reset-video") {
          const accepted = enqueueVideoReset(
            context,
            "client requested keyframe",
          );
          void accepted.completion
            .then((result) => {
              if (acknowledge) {
                reply({ ok: true, status: result.status });
              }
            })
            .catch((err) => {
              if (acknowledge) {
                reply(inputErrorPayload(err, "failed"));
              }
            });
          return;
        }
        const accepted = enqueueClientGesture(
          ws,
          msg,
          shouldRecordPayload(payload),
        );
        void accepted.completion
          .then((result) => {
            if (acknowledge) {
              reply({ ok: true, status: result.status });
            }
          })
          .catch((err) => {
            if (acknowledge) {
              reply(inputErrorPayload(err, "failed"));
            }
          });
      } catch (err) {
        if (acknowledge) {
          reply(inputErrorPayload(err, "rejected"));
        }
      }
    },
    close(ws) {
      if (ws.data.handle) {
        releaseClientTouches(ws.data.handle);
        ws.data.context.clients.delete(ws.data.handle);
      }
    },
  };

  /** Upgrades a `/ws` request for a streaming session; 503 with health otherwise. */
  const upgrade = (
    req: Request,
    url: URL,
    srv: Server<WsData>,
    context: DeviceContext,
  ): Response => {
    if (context.status !== "streaming") {
      return new Response(JSON.stringify(health(context)), {
        status: 503,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    const frameMeta = url.searchParams.get("frame-meta") === "1";
    const ok = srv.upgrade(req, {
      data: { id: nextId++, frameMeta, context },
    });
    if (ok) return undefined as unknown as Response;
    return new Response("upgrade failed", { status: 400 });
  };

  return { handlers, upgrade };
}
