import { commandFailureOf } from "../command-failure.ts";
import { ControlInputError } from "../control-input-queue.ts";
import { SessionChangedError } from "../device-session-context.ts";
import { MultipartUploadError } from "../multipart-upload.ts";
import { HttpBodyError } from "../request-body.ts";
import {
  RoutePlaybackApplyError,
  RoutePlaybackConflictError,
} from "../route-playback.ts";
import {
  SessionReplayConflictError,
  SessionReplayValidationError,
} from "../session-recorder.ts";
import { UploadManagerError } from "../upload-manager.ts";
import {
  API_ERROR_STATUS,
  ApiError,
  internalApiError,
  type ApiErrorCode,
} from "./api-error.ts";

/**
 * How `toApiError` classifies an error it has no entry for. Route handlers
 * throw plain errors for invalid input, so the errors they catch default to
 * `invalid_request`; the router passes `internal_error` for errors no handler
 * caught.
 */
export type ApiErrorFallback = "invalid_request" | "internal_error";

const UPLOAD_MANAGER_ERRORS: Record<
  UploadManagerError["code"],
  readonly [ApiErrorCode, string]
> = {
  "queue-full": ["rate_limited", "upload-queue-full"],
  "queue-timeout": ["service_unavailable", "upload-queue-timeout"],
  closed: ["service_unavailable", "upload-service-closed"],
  "device-session-changed": ["conflict", "device-session-changed"],
  "upload-cancelled": ["invalid_request", "upload-cancelled"],
};

const message = (err: unknown) =>
  err instanceof Error && err.message ? err.message : String(err);

const api = (
  code: ApiErrorCode,
  text: string,
  cause: unknown,
  reason?: string,
) => new ApiError(API_ERROR_STATUS[code], code, text, { cause, reason });

/**
 * The single translation from internal errors to API failures. Codes come
 * from API_ERROR_CODES, each sent with the one status API_ERROR_STATUS gives
 * it; finer distinctions the codes do not carry (a full upload queue vs a full
 * control queue, which adb step failed) go in `reason`.
 *
 * A downstream failure or timeout sends the command's public message, which
 * names the operation and never its output; an internal failure sends a fixed
 * message.
 * The original error is kept as `cause` for the log, never sent to the
 * client.
 */
export function toApiError(
  err: unknown,
  fallback: ApiErrorFallback = "invalid_request",
): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof SessionChangedError) {
    return api("conflict", message(err), err, err.code);
  }
  if (err instanceof HttpBodyError) {
    switch (err.code) {
      case "payload-too-large":
        return api("payload_too_large", message(err), err);
      case "too-many-body-chunks":
        return api("payload_too_large", message(err), err, err.code);
      case "invalid-json":
        return api("invalid_json", message(err), err);
      default:
        return api("invalid_request", message(err), err, err.code);
    }
  }
  if (err instanceof MultipartUploadError) {
    return err.code === "upload-write-failed" || err.code === "upload-cleanup-failed"
      ? api("internal_error", "upload could not be stored", err, err.code)
      : api("invalid_request", message(err), err, err.code);
  }
  if (err instanceof UploadManagerError) {
    const [code, reason] = UPLOAD_MANAGER_ERRORS[err.code];
    return api(code, message(err), err, reason);
  }
  if (err instanceof ControlInputError) {
    return api(
      err.code === "control-queue-overloaded" ? "rate_limited" : "service_unavailable",
      message(err),
      err,
      err.code,
    );
  }
  if (err instanceof RoutePlaybackConflictError) {
    return api("conflict", message(err), err);
  }
  // adb or emulator failures, also as the cause of a route location update:
  // only the operation's public message, never the command's output. A timed
  // out adb command is a 504, a device adb cannot reach is a 503, and every
  // other command failure is a 502.
  const failure = commandFailureOf(err);
  if (failure) {
    return api(
      failure.code === "adb-timeout"
        ? "downstream_timeout"
        : failure.code === "adb-device-unavailable"
          ? "service_unavailable"
          : "downstream_failure",
      failure.publicMessage,
      err,
      failure.code,
    );
  }
  if (err instanceof RoutePlaybackApplyError) {
    // Route playback builds this message with publicErrorMessage, so it is
    // safe to send (for example, that location needs an emulator).
    return api("downstream_failure", message(err), err);
  }
  if (err instanceof SessionReplayValidationError) {
    return api("invalid_request", message(err), err);
  }
  if (err instanceof SessionReplayConflictError) {
    return api("conflict", message(err), err);
  }
  return fallback === "internal_error"
    ? internalApiError(err)
    : api("invalid_request", message(err), err);
}
