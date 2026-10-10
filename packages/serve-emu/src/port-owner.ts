import { displayHost } from "./access-policy.ts";

const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);
// The probed body is printed, so only plain values pass: no escape codes.
const SERIAL = /^[A-Za-z0-9._:-]{1,128}$/;
const STATUSES = new Set(["streaming", "stopped", "error"]);
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Names the serve-emu that already listens on `port`, from its `/health`, so
 * a bind failure points at a stale server instead of a generic error (#73).
 * Resolves null when the port's owner does not answer like serve-emu.
 */
export async function describePortOwner(host: string, port: number): Promise<string | null> {
  const target = WILDCARD_HOSTS.has(host) ? "127.0.0.1" : displayHost(host);
  let body: unknown;
  try {
    const response = await fetch(`http://${target}:${port}/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    body = await response.json();
  } catch {
    return null;
  }
  if (!isRecord(body)) return null;
  // /health answers 503 unless streaming; the snapshot is the same shape.
  if (
    typeof body.serial === "string" &&
    SERIAL.test(body.serial) &&
    typeof body.status === "string" &&
    STATUSES.has(body.status)
  ) {
    const since =
      typeof body.startedAt === "string" && TIMESTAMP.test(body.startedAt)
        ? `, session started ${body.startedAt}`
        : "";
    return `Port ${port} is already used by another serve-emu (device ${body.serial}, status ${body.status}${since}).`;
  }
  if (body.ok === false && isRecord(body.error)) {
    // A missing token is 401; a 403 (such as a rejected Host) is not about
    // the token, so it only says whose port it is.
    return body.error.code === "unauthorized"
      ? `Port ${port} is already used by another serve-emu, which requires a token.`
      : body.error.code === "forbidden"
        ? `Port ${port} is already used by another serve-emu.`
        : null;
  }
  return null;
}
