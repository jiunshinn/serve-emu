import {
  commandFailureOf,
  logApiFailure,
  publicErrorMessage,
} from "./command-failure.ts";
import {
  RoutePlaybackConflictError,
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

export async function startRoutePlaybackResponse(
  playback: RouteStarter,
  request: RoutePlaybackRequest,
  isCurrent: () => boolean = () => true,
): Promise<Response> {
  if (!isCurrent()) {
    return routePlaybackErrorResponse(
      new RoutePlaybackConflictError(
        "device session changed before route playback start",
      ),
    );
  }
  try {
    const route: RoutePlaybackSnapshot = await playback.start(request);
    return Response.json({ ok: true, route });
  } catch (error) {
    return routePlaybackErrorResponse(error);
  }
}
