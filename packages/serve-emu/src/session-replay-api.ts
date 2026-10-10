import { apiErrorResponse } from "./api/api-error.ts";
import { toApiError, type ApiErrorFallback } from "./api/error-mapping.ts";
import {
  SessionReplayConflictError,
  type ReplayHandlers,
  type SessionRecorder,
} from "./session-recorder.ts";

type ReplayController = Pick<
  SessionRecorder,
  "startReplay" | "cancelAndWait" | "clear"
>;

/** Replay failures: validation 400, conflicts 409, anything else 500. */
export function sessionReplayErrorResponse(
  error: unknown,
  fallback: ApiErrorFallback = "internal_error",
): Response {
  const apiError = toApiError(error, fallback);
  if (apiError.status >= 500) console.error(`[api] ${apiError.message}:`, error);
  return apiErrorResponse(apiError);
}

export function startSessionReplayResponse(
  recorder: ReplayController,
  handlers: ReplayHandlers,
  multiplier: number,
  isCurrent: () => boolean = () => true,
): Response {
  if (!isCurrent()) {
    return sessionReplayErrorResponse(
      new SessionReplayConflictError(
        "device session changed before session replay start",
      ),
    );
  }
  try {
    const replay = recorder.startReplay(handlers, multiplier);
    return Response.json({ ok: true, session: replay.snapshot });
  } catch (error) {
    return sessionReplayErrorResponse(error);
  }
}

export async function stopSessionReplayResponse(
  recorder: ReplayController,
): Promise<Response> {
  try {
    return Response.json({
      ok: true,
      session: await recorder.cancelAndWait(),
    });
  } catch (error) {
    return sessionReplayErrorResponse(error);
  }
}

export function clearSessionReplayResponse(
  recorder: ReplayController,
): Response {
  try {
    return Response.json({ ok: true, session: recorder.clear() });
  } catch (error) {
    return sessionReplayErrorResponse(error);
  }
}
