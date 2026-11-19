import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import {
  ControlInputError,
  type ControlInputHandle,
  type ControlPacketHandle,
} from "../control-input-queue.ts";
import type { DeviceSessionManager } from "../device-session-context.ts";
import type { Gesture } from "../input.ts";
import { shouldRecordPayload } from "../session-api.ts";
import { epochNowMs } from "../shared/frame-meta.ts";
import {
  parseWsClientMessage,
  parseWsRequestId,
} from "../shared/websocket-contracts.ts";
import type { Client, DeviceContext, WsData } from "./types.ts";

const MAX_WS_MESSAGE_BYTES = 16 * 1024;
type KeyGesture = Extract<Gesture, { type: "key" }>;
type HeldKey = { owner: Client; gesture: KeyGesture; record: boolean };

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
 * (gestures, key frame requests, clock sync) and held-input release on close.
 */
export function createWebSocketEndpoint(deps: {
  sessions: DeviceSessionManager<DeviceContext>;
  join: (client: Client) => void;
  enqueueGesture: (
    context: DeviceContext,
    gesture: Gesture,
    source: string,
    record?: boolean,
  ) => ControlInputHandle;
  enqueueVideoReset: (
    client: Client,
    reason: string,
  ) => ControlPacketHandle;
  /** The body of the 503 an upgrade gets while the session is not streaming. */
  health: (context: DeviceContext) => unknown;
}) {
  const { sessions, join, enqueueGesture, enqueueVideoReset, health } =
    deps;
  let nextId = 1;
  let nextTouchId = 1;
  const heldKeys = new WeakMap<DeviceContext, Map<number, HeldKey>>();

  const enqueueClientKey = (
    client: Client,
    gesture: KeyGesture,
    recordRequested: boolean,
  ) => {
    const { context } = client;
    const keys = heldKeys.get(context) ?? new Map<number, HeldKey>();
    const previous = keys.get(gesture.keycode);
    if (previous && (previous.owner !== client || gesture.action === undefined)) {
      throw new Error("key is already held");
    }
    const record = previous?.record ?? recordRequested;
    const accepted = enqueueGesture(context, gesture, "ws", record);
    if (gesture.action === "down" && !previous) {
      keys.set(gesture.keycode, { owner: client, gesture, record });
      heldKeys.set(context, keys);
    } else if (gesture.action === "up") {
      keys.delete(gesture.keycode);
    }
    return accepted;
  };

  const enqueueClientGesture = (
    ws: ServerWebSocket<WsData>,
    gesture: Gesture,
    recordRequested: boolean,
  ) => {
    const client = ws.data.handle;
    if (gesture.type !== "touch" && gesture.type !== "key")
      return enqueueGesture(ws.data.context, gesture, "ws", recordRequested);
    if (!client) throw new Error("WebSocket client is not open");
    if (gesture.type === "key") {
      return enqueueClientKey(client, gesture, recordRequested);
    }
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

  const releaseClientInputs = (client: Client, source = "ws:disconnect") => {
    // The input queue reserves an UP slot for every admitted DOWN, even when full.
    // Never redirect a late disconnect's releases onto a replacement session.
    const completions: Promise<unknown>[] = [];
    const release = (gesture: Gesture, record: boolean) => {
      if (!sessions.isCurrent(client.context)) return;
      try {
        const accepted = enqueueGesture(client.context, gesture, source, record);
        void accepted.completion.catch(() => {});
        completions.push(accepted.completion);
      } catch {}
    };
    for (const { gesture, record } of client.touches.values()) {
      release({ ...gesture, action: "up" }, record);
    }
    client.touches.clear();
    const keys = heldKeys.get(client.context);
    for (const [keycode, { owner, gesture, record }] of keys ?? []) {
      if (owner !== client) continue;
      keys!.delete(keycode);
      release({ ...gesture, action: "up" }, record);
    }
    return Promise.allSettled(completions);
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
        video: ws.data.video,
        sentFrames: 0,
        droppedFrames: 0,
        backpressureEvents: 0,
        awaitingKeyFrame: false,
        awaitingKeyFrameSinceMs: null,
        lastKeyFrameRequestMs: null,
      };
      context.clients.add(handle);
      ws.data.handle = handle;
      if (ws.data.control) {
        sendJson(ws, { type: "control-ready", serial: context.serial });
      }
      if (handle.video) join(handle);
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
        if (msg.type === "release-input") {
          const client = ws.data.handle;
          if (!client) throw new Error("WebSocket client is not open");
          void releaseClientInputs(client, "ws:release").then(() => {
            if (acknowledge) reply({ ok: true, status: "completed" });
          });
          return;
        }
        if (msg.type === "reset-video") {
          const client = ws.data.handle;
          if (!client) throw new Error("WebSocket client is not open");
          const accepted = enqueueVideoReset(
            client,
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
        void releaseClientInputs(ws.data.handle);
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
    const control = url.searchParams.get("control") === "1";
    const video = url.searchParams.get("video") !== "0";
    const ok = srv.upgrade(req, {
      data: { id: nextId++, frameMeta, control, video, context, handlers },
    });
    if (ok) return undefined as unknown as Response;
    return new Response("upgrade failed", { status: 400 });
  };

  return { handlers, upgrade };
}
