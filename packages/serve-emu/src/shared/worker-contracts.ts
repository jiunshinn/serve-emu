// Messages between the UI thread (use-stream.ts) and the stream worker
// (stream-worker.ts). Both import these types; the worker validates every
// command with parseWorkerCommand.

export type StreamPhase =
  | "connecting"
  | "awaiting-keyframe"
  | "decoding"
  | "rendered"
  | "recovering"
  | "disconnected"
  | "stopped";

export type StreamGenerationReason =
  | "initial"
  | "connect"
  | "reconnect"
  | "video-session"
  | "decoder-recovery"
  | "disconnect"
  | "stop";

export type StreamLifecycleState = {
  generation: number;
  phase: StreamPhase;
  reason: StreamGenerationReason;
  generationStartedAt: number;
  socketOpenedAt: number | null;
  lastPacketAt: number | null;
  lastRenderedAt: number | null;
  rendered: boolean;
  codec: string | null;
};

export type StreamStats = {
  fps: number;
  decodeQueue: number;
  transitMs: number | null;
  e2eMs: number | null;
  codec: string | null;
  rendered: boolean;
  decodeMsP95: number | null;
  presentMsP95: number | null;
  decodePendingMs: number;
  recoveries: number;
  clockUncertaintyMs: number | null;
};

/** An event as the worker produces it; postEvent stamps the client epoch. */
export type StreamWorkerEventPayload =
  | {
      type: "control-error";
      generation: number;
      error: string;
      requestId?: string;
    }
  | { type: "lifecycle"; generation: number; state: StreamLifecycleState }
  | { type: "status"; generation: number; status: string }
  | {
      type: "session";
      generation: number;
      size: { width: number; height: number };
    }
  | { type: "rendered"; generation: number; at: number }
  | { type: "stats"; generation: number; stats: StreamStats }
  | {
      type: "control-dropped";
      generation: number;
      reason: "socket-not-open" | "send-failed";
    };

export type StreamWorkerEvent = StreamWorkerEventPayload & {
  clientEpoch: number;
};

/** Canvas is generic so this contract does not require DOM or WebWorker types. */
export type WorkerCommand<Canvas = unknown> =
  | { type: "init"; clientEpoch: number; canvas: Canvas; url: string }
  | { type: "connect"; clientEpoch: number }
  | { type: "send"; clientEpoch: number; text: string }
  | { type: "stop"; clientEpoch: number };

/** Client epochs are positive integers; the UI starts at 1 for each canvas. */
export function isValidClientEpoch(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Validates a message posted to the stream worker. Returns null for anything
 * the worker must ignore: a non-object, an unknown type, a missing or invalid
 * client epoch, or a malformed payload.
 */
export function parseWorkerCommand<Canvas>(
  value: unknown,
  isCanvas: (value: unknown) => value is Canvas,
): WorkerCommand<Canvas> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const clientEpoch = item.clientEpoch;
  if (!isValidClientEpoch(clientEpoch)) return null;
  switch (item.type) {
    case "init":
      if (!isCanvas(item.canvas) || typeof item.url !== "string" || !item.url) return null;
      return { type: "init", clientEpoch, canvas: item.canvas, url: item.url };
    case "connect":
      return { type: "connect", clientEpoch };
    case "send":
      return typeof item.text === "string" ? { type: "send", clientEpoch, text: item.text } : null;
    case "stop":
      return { type: "stop", clientEpoch };
    default:
      return null;
  }
}
