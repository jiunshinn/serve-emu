import { timingSafeEqual } from "node:crypto";
import { ApiError, apiErrorResponse } from "../api/api-error.ts";
import {
  createHostAllowlist,
  fetchMetadataAllowed,
  normalizeHostname,
} from "./request-policy.ts";

const SESSION_COOKIE = "semu_session";

/** Constant-time string compare that never throws on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    out[key] = part.slice(idx + 1).trim();
  }
  return out;
}

/** Token presented by the request, from bearer header, cookie, or query. */
function presentedToken(req: Request, url: URL): string | null {
  const authorization = req.headers.get("authorization");
  if (authorization && authorization.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }
  const cookie = parseCookies(req.headers.get("cookie"))[SESSION_COOKIE];
  if (cookie) return cookie;
  return url.searchParams.get("token");
}

/**
 * Same-origin guard for state-changing requests and the WebSocket upgrade.
 * A missing Origin means a non-browser client (CLI/agent), which is gated by
 * the token check instead. A present Origin must match the request Host.
 */
function originAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  return originHost === req.headers.get("host");
}

function forbiddenResponse(message: string): Response {
  return apiErrorResponse(new ApiError(403, "forbidden", message));
}

/**
 * The access-control gate every request passes before routing. Returns the
 * response that ends the request (a 403, a 401, or the token-cookie bootstrap
 * redirect), or null when the request may go on to the API, `/health`, `/ws`,
 * or the UI. Throws at startup on an invalid allowed host name.
 */
export function createRequestGate(options: {
  /** Shared secret; empty or undefined disables auth. */
  token: string | undefined;
  /** The bind address, always served while auth is disabled. */
  host: string;
  allowedHosts: readonly string[] | undefined;
}): (req: Request, url: URL) => Response | null {
  const authToken =
    options.token && options.token.length > 0 ? options.token : null;
  for (const name of options.allowedHosts ?? []) {
    if (!normalizeHostname(name)) {
      throw new Error(`invalid allowed host ${JSON.stringify(name)}`);
    }
  }
  const hostAllowed = createHostAllowlist([
    options.host,
    ...(options.allowedHosts ?? []),
  ]);
  let warnedForbiddenHost = false;

  const tokenValid = (req: Request, url: URL): boolean => {
    if (!authToken) return true;
    const presented = presentedToken(req, url);
    return presented !== null && safeEqual(presented, authToken);
  };

  return (req, url) => {
    // DNS-rebinding guard: without a token, a page whose own host name was
    // rebound to this address would pass the same-origin check below, so
    // only host names that cannot be rebound are served. With a token, the
    // secret and the host-scoped cookie already keep such pages out.
    if (!authToken) {
      const hostHeader = req.headers.get("host");
      if (!hostAllowed(hostHeader)) {
        if (!warnedForbiddenHost) {
          warnedForbiddenHost = true;
          console.warn(
            `Rejected a request for host ${JSON.stringify(hostHeader?.slice(0, 100))}. ` +
              "Without --token only IP addresses, localhost, and --allowed-host names are served.",
          );
        }
        return forbiddenResponse("forbidden host");
      }
    }
    if (!fetchMetadataAllowed(req)) {
      return forbiddenResponse("forbidden cross-site request");
    }

    // Bootstrap: exchange a valid one-time URL token for an HttpOnly cookie,
    // then redirect to a clean URL so the secret never lingers in the address
    // bar, browser history, or referer logs. Same-origin fetch/EventSource/WS
    // calls carry the cookie automatically afterward. Scoped to browser
    // navigations (Accept: text/html) so agents hitting `/api?token=` still
    // get their JSON response instead of a redirect.
    if (
      authToken &&
      req.method === "GET" &&
      (req.headers.get("accept") ?? "").includes("text/html")
    ) {
      const queryToken = url.searchParams.get("token");
      if (queryToken && safeEqual(queryToken, authToken)) {
        const clean = new URL(url);
        clean.searchParams.delete("token");
        return new Response(null, {
          status: 303,
          headers: {
            Location: `${clean.pathname}${clean.search}`,
            "Set-Cookie": `${SESSION_COOKIE}=${authToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
          },
        });
      }
    }

    if (!tokenValid(req, url)) {
      return apiErrorResponse(
        new ApiError(401, "unauthorized", "unauthorized", {
          headers: { "WWW-Authenticate": "Bearer" },
        }),
      );
    }

    // CSRF / cross-origin guard: reject upgrades and state-changing requests
    // whose Origin does not match the host. Applied even without auth so the
    // control channel is never open to arbitrary cross-origin pages.
    if (
      url.pathname === "/ws" ||
      (req.method !== "GET" && req.method !== "HEAD")
    ) {
      if (!originAllowed(req)) return forbiddenResponse("forbidden origin");
    }
    return null;
  };
}
