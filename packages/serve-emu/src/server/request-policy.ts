import { isIP } from "node:net";

/**
 * Reduces a Host header or a configured host name to a lowercase hostname
 * without port, IPv6 brackets, or trailing dot. Returns null for anything that
 * is not a bare `host[:port]` authority.
 */
export function normalizeHostname(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || /[\s/?#@\\]/.test(trimmed)) return null;
  // `--host ::1` is a bare IPv6 address, which is not a valid URL authority.
  if (isIP(trimmed) === 6) return trimmed.toLowerCase();
  let hostname: string;
  try {
    hostname = new URL(`http://${trimmed}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1);
  }
  if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);
  return hostname || null;
}

/**
 * Host names a server without a token answers to. A hostile page can rebind
 * its own DNS name to 127.0.0.1 and then pass any same-origin check, so only
 * names that never go through DNS (IP literals and `localhost`) are accepted,
 * plus names the user configured explicitly.
 */
export function createHostAllowlist(
  configured: Iterable<string | undefined>,
): (hostHeader: string | null) => boolean {
  const allowed = new Set<string>();
  for (const name of configured) {
    if (!name) continue;
    const hostname = normalizeHostname(name);
    if (hostname) allowed.add(hostname);
  }
  return (hostHeader) => {
    // Browsers always send Host. A request without one is a raw HTTP client,
    // which cannot be a rebound page.
    if (hostHeader === null) return true;
    const hostname = normalizeHostname(hostHeader);
    if (!hostname) return false;
    return (
      isIP(hostname) !== 0 ||
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      allowed.has(hostname)
    );
  };
}

/**
 * Fetch Metadata resource isolation. Browsers label requests started by
 * another site `Sec-Fetch-Site: cross-site`; only navigations may cross sites
 * (opening the UI from a link, or an IDE browser that frames it). Clients that
 * send no Fetch Metadata, such as the CLI and agents, are unaffected.
 */
export function fetchMetadataAllowed(req: Request): boolean {
  if (req.headers.get("sec-fetch-site") !== "cross-site") return true;
  const dest = req.headers.get("sec-fetch-dest");
  return (
    (req.method === "GET" || req.method === "HEAD") &&
    req.headers.get("sec-fetch-mode") === "navigate" &&
    dest !== "object" &&
    dest !== "embed"
  );
}
