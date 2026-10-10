import { SessionChangedError } from "./device-session-context.ts";
import {
  commandFailureOf,
  logApiFailure,
  publicErrorMessage,
} from "./command-failure.ts";
import {
  routePlaybackErrorStatus,
  type RoutePlayback,
  type RoutePlaybackRequest,
  type RoutePlaybackSnapshot,
} from "./route-playback.ts";

type RouteStarter = Pick<RoutePlayback, "start">;

/**
 * A route playback failure in the legacy `{ ok, code?, error }` shape. A
 * command failure keeps its `code` (as in `/api/location`) and only its public
 * message. Given the `request`, server failures are logged with the original
 * error.
 */
export function routePlaybackErrorResponse(
  error: unknown,
  status = routePlaybackErrorStatus(error),
  request?: Pick<Request, "method" | "url">,
): Response {
  const failure = commandFailureOf(error);
  const message = publicErrorMessage(error);
  if (request && status >= 500) logApiFailure(request, status, message, error);
  return Response.json(
    {
      ok: false,
      ...(failure ? { code: failure.code } : {}),
      error: message,
    },
    { status },
  );
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
