import type { ServerWebSocket } from "bun";
import type { ActiveDeviceSession } from "../device-session-context.ts";
import type { Gesture } from "../input.ts";

// Server-side shapes shared by server.ts, its modules, and the API routes.
// They live here, not in server.ts, so route types do not import the server.

export type WsData = {
  id: number;
  frameMeta: boolean;
  context: DeviceContext;
  handle?: Client;
};

export type Client = {
  touches: Map<
    number,
    { gesture: Extract<Gesture, { type: "touch" }>; record: boolean }
  >;
  id: number;
  ws: ServerWebSocket<WsData>;
  context: DeviceContext;
  frameMeta: boolean;
  sentFrames: number;
  droppedFrames: number;
  backpressureEvents: number;
  awaitingKeyFrame: boolean;
  awaitingKeyFrameSinceMs: number | null;
  lastKeyFrameRequestMs: number | null;
};

export type DeviceContext = ActiveDeviceSession<Client>;
