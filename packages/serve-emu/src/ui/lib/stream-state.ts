import type { DeviceSize } from "../../shared/api-contracts";

// Lenient /health parser for the stream hook. It reads only what the hook
// needs, so it keeps working while the full HealthResponse contract evolves.

export type StreamHealth = {
  serial?: string;
  generation?: number;
  size: DeviceSize;
  status?: "streaming" | "stopped" | "error";
  lastFrameAt?: string | null;
  lastError?: string | null;
  /** From `contention`; absent until the server's first probe answers. */
  otherScrcpySessions?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSize(value: unknown): DeviceSize {
  if (!isRecord(value)) throw new Error("health size must be an object");
  if (
    typeof value.width !== "number" ||
    !Number.isFinite(value.width) ||
    typeof value.height !== "number" ||
    !Number.isFinite(value.height)
  ) {
    throw new Error("health size must contain finite dimensions");
  }
  return { width: value.width, height: value.height };
}

export function parseStreamHealth(value: unknown): StreamHealth {
  if (!isRecord(value)) throw new Error("health response must be an object");
  if (value.serial !== undefined && (typeof value.serial !== "string" || !value.serial)) {
    throw new Error("health serial is invalid");
  }
  if (value.generation !== undefined && (typeof value.generation !== "number" || !Number.isSafeInteger(value.generation) || value.generation < 0)) {
    throw new Error("health generation is invalid");
  }
  const status = value.status;
  if (
    status !== undefined &&
    status !== "streaming" &&
    status !== "stopped" &&
    status !== "error"
  ) {
    throw new Error("health status is invalid");
  }
  const lastFrameAt = value.lastFrameAt;
  if (
    lastFrameAt !== undefined &&
    lastFrameAt !== null &&
    typeof lastFrameAt !== "string"
  ) {
    throw new Error("health lastFrameAt is invalid");
  }
  const lastError = value.lastError;
  if (
    lastError !== undefined &&
    lastError !== null &&
    typeof lastError !== "string"
  ) {
    throw new Error("health lastError is invalid");
  }
  // Diagnostics only: a malformed value is ignored rather than failing the poll.
  const contention = value.contention;
  const otherScrcpySessions =
    isRecord(contention) &&
    typeof contention.otherScrcpySessions === "number" &&
    Number.isSafeInteger(contention.otherScrcpySessions) &&
    contention.otherScrcpySessions >= 0
      ? contention.otherScrcpySessions
      : undefined;
  return {
    size: parseSize(value.size),
    ...(value.serial === undefined ? {} : { serial: value.serial as string }),
    ...(value.generation === undefined ? {} : { generation: value.generation as number }),
    ...(status === undefined ? {} : { status }),
    ...(lastFrameAt === undefined ? {} : { lastFrameAt }),
    ...(lastError === undefined ? {} : { lastError }),
    ...(otherScrcpySessions === undefined ? {} : { otherScrcpySessions }),
  };
}
