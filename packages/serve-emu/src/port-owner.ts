import { displayHost } from "./access-policy.ts";

const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Names the serve-emu that already listens on `port`, from its `/health`, so
 * a bind failure points at a stale server instead of a generic error (#73).
 * Resolves null when the port's owner does not answer like serve-emu.
 */
export async function describePortOwner(
  host: string,
  port: number,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const target = WILDCARD_HOSTS.has(host) ? "127.0.0.1" : displayHost(host);
  let body: unknown;
  try {
    const response = await fetchImpl(`http://${target}:${port}/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    body = await response.json();
  } catch {
    return null;
  }
  if (!isRecord(body)) return null;
  // /health answers 503 unless streaming; the snapshot is the same shape.
  if (typeof body.serial === "string" && typeof body.status === "string") {
    const since =
      typeof body.startedAt === "string" ? `, session started ${body.startedAt}` : "";
    return `Port ${port} is already used by another serve-emu (device ${body.serial}, status ${body.status}${since}).`;
  }
  if (
    body.ok === false &&
    isRecord(body.error) &&
    (body.error.code === "unauthorized" || body.error.code === "forbidden")
  ) {
    return `Port ${port} is already used by another serve-emu, which requires a token.`;
  }
  return null;
}
