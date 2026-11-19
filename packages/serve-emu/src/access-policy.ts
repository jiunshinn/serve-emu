import { isIP } from "node:net";

/**
 * Characters a token may contain. They pass through the startup URL, the
 * `semu_session` cookie, and the `Authorization` header without encoding.
 */
const TOKEN_RE = /^[A-Za-z0-9._~-]+$/;
export const TOKEN_CHARACTERS = "letters, digits, '.', '_', '~', and '-'";

/** IPv4-mapped 127.0.0.0/8, as the URL parser serializes it (`::ffff:7f00:1`). */
const MAPPED_LOOPBACK_RE = /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/;

/**
 * Whether binding to `host` only accepts connections from this machine.
 *
 * Only literal addresses and `localhost` count. Hosts are normalized with the
 * WHATWG URL parser first, so `127.1`, `0:0:0:0:0:0:0:1`, and
 * `::ffff:127.0.0.1` are recognized. Any other name (`127.example.com`, for
 * example) may resolve anywhere and is treated as non-loopback.
 */
export function isLoopbackHost(host: string): boolean {
  const trimmed = host.trim();
  if (!trimmed) return false;
  const literal =
    trimmed.includes(":") && !trimmed.startsWith("[") ? `[${trimmed}]` : trimmed;
  let hostname: string;
  try {
    hostname = new URL(`http://${literal}/`).hostname;
  } catch {
    return false;
  }
  if (hostname === "localhost") return true;
  if (isIP(hostname) === 4) return hostname.startsWith("127.");
  return hostname === "[::1]" || MAPPED_LOOPBACK_RE.test(hostname);
}

export class InvalidTokenError extends Error {
  constructor() {
    super(`--token may only contain ${TOKEN_CHARACTERS}.`);
    this.name = "InvalidTokenError";
  }
}

export function assertValidToken(token: string): void {
  if (!TOKEN_RE.test(token)) throw new InvalidTokenError();
}

export type AccessPolicyInput = {
  host: string;
  token?: string;
  unsafeNoAuth?: boolean;
  generateToken: () => string;
};

export type AccessPolicy = {
  /** Required on every request when set; undefined means auth is off. */
  token: string | undefined;
  loopback: boolean;
  warnings: string[];
};

/**
 * Loopback binds keep auth off unless a token is given. Non-loopback binds
 * require a token (the given one, or a generated one) unless the user
 * explicitly passes --unsafe-no-auth.
 */
export function resolveAccessPolicy(input: AccessPolicyInput): AccessPolicy {
  const given = input.token || undefined;
  if (given !== undefined) assertValidToken(given);
  const loopback = isLoopbackHost(input.host);
  if (loopback) return { token: given, loopback, warnings: [] };
  if (input.unsafeNoAuth) {
    return {
      token: undefined,
      loopback,
      warnings: [
        `WARNING: bound to non-loopback address ${input.host} with --unsafe-no-auth. ` +
          "The device is reachable and controllable without authentication.",
      ],
    };
  }
  return { token: given ?? input.generateToken(), loopback, warnings: [] };
}

/** Address to show in the clickable startup URL (wildcard binds → localhost). */
export function displayHost(host: string): string {
  if (host === "0.0.0.0" || host === "::" || host === "[::]") return "localhost";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function startupUrl(base: string, token: string | undefined): string {
  return token ? `${base}/?token=${encodeURIComponent(token)}` : `${base}/`;
}
