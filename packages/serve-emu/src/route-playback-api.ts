import { apiErrorResponse } from "./api/api-error.ts";
import { toApiError } from "./api/error-mapping.ts";
import { logApiFailure } from "./command-failure.ts";
import { SessionChangedError } from "./device-session-context.ts";
import type {
  RoutePlayback,
  RoutePlaybackRequest,
  RoutePlaybackSnapshot,
} from "./route-playback.ts";

type RouteStarter = Pick<RoutePlayback, "start">;

/**
 * A route playback failure in the ApiFailure shape: conflicts 409, failed
 * location updates 502 (`downstream_failure`), anything else 500. Given the
 * `request`, server failures are logged with its method and path and the
 * original error, which the response leaves out.
 */
export function routePlaybackErrorResponse(
  error: unknown,
  fallback: "invalid_request" | "internal_error" = "internal_error",
  request?: Pick<Request, "method" | "url">,
): Response {
  const apiError = toApiError(error, fallback);
  if (request && apiError.status >= 500) {
    logApiFailure(request, apiError.status, apiError.message, error);
  }
  return apiErrorResponse(apiError);
}

export type StartRoutePlaybackOptions = {
  /**
   * Throws a SessionChangedError once the caller's device session is gone.
   * Checked before the start and again once it resolves.
   */
  assertCurrent?: () => void;
  /** Wraps the start so its owner can wait for it (a device session's drain). */
  track?: (
    start: Promise<RoutePlaybackSnapshot>,
  ) => Promise<RoutePlaybackSnapshot>;
  /** The HTTP request; given, server failures are logged with its method and path. */
  req?: Pick<Request, "method" | "url">;
};

/**
 * POST /api/route: start playback and map its failures to a response. A
 * SessionChangedError is rethrown instead, so the caller answers it with the
 * API's `session_changed` error like any other request from an old session.
 */
export async function startRoutePlaybackResponse(
  playback: RouteStarter,
  request: RoutePlaybackRequest,
  {
    assertCurrent = () => {},
    track = (start) => start,
    req,
  }: StartRoutePlaybackOptions = {},
): Promise<Response> {
  try {
    assertCurrent();
    const route = await track(playback.start(request));
    assertCurrent();
    return Response.json({ ok: true, route });
  } catch (error) {
    if (error instanceof SessionChangedError) throw error;
    return routePlaybackErrorResponse(error, undefined, req);
  }
}
