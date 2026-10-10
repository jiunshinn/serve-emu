import { describe, expect, test } from "bun:test";
import { ApiError } from "../src/api/api-error.ts";
import { toApiError } from "../src/api/error-mapping.ts";
import { AppManagementError } from "../src/app-management.ts";
import { ControlInputError } from "../src/control-input-queue.ts";
import { SessionChangedError } from "../src/device-session-context.ts";
import { MultipartUploadError } from "../src/multipart-upload.ts";
import { HttpBodyError } from "../src/request-body.ts";
import { RoutePlaybackApplyError, RoutePlaybackConflictError } from "../src/route-playback.ts";
import { SessionReplayConflictError, SessionReplayValidationError } from "../src/session-recorder.ts";
import { UploadManagerError } from "../src/upload-manager.ts";
import { parseApiFailure } from "../src/shared/api-contracts.ts";
import { apiErrorResponse } from "../src/api/api-error.ts";

type Row = [string, unknown, number, string, string | undefined, string | RegExp];

const rows: Row[] = [
  ["session changed", new SessionChangedError(1, 2), 409, "conflict", "session_changed", /generation 1 to 2/],
  ["body too large", new HttpBodyError("payload-too-large", "request body exceeds 8192 bytes"), 413, "payload_too_large", undefined, "request body exceeds 8192 bytes"],
  ["too many chunks", new HttpBodyError("too-many-body-chunks", "too many chunks"), 413, "payload_too_large", "too-many-body-chunks", "too many chunks"],
  ["invalid JSON", new HttpBodyError("invalid-json", "request body is not valid JSON"), 400, "invalid_json", undefined, "request body is not valid JSON"],
  ["aborted body", new HttpBodyError("request-aborted", "request was aborted"), 400, "invalid_request", "request-aborted", "request was aborted"],
  ["bad multipart", new MultipartUploadError("invalid-multipart", "not multipart"), 400, "invalid_request", "invalid-multipart", "not multipart"],
  ["upload write failure", new MultipartUploadError("upload-write-failed", "EIO: /tmp/x"), 500, "internal_error", "upload-write-failed", "upload could not be stored"],
  ["upload queue full", new UploadManagerError("queue-full", "upload queue is full"), 429, "rate_limited", "upload-queue-full", "upload queue is full"],
  ["upload queue timeout", new UploadManagerError("queue-timeout", "timed out"), 503, "service_unavailable", "upload-queue-timeout", "timed out"],
  ["upload service closed", new UploadManagerError("closed", "closed"), 503, "service_unavailable", "upload-service-closed", "closed"],
  ["upload after switch", new UploadManagerError("device-session-changed", "switched"), 409, "conflict", "device-session-changed", "switched"],
  ["upload cancelled", new UploadManagerError("upload-cancelled", "cancelled"), 400, "invalid_request", "upload-cancelled", "cancelled"],
  ["control queue full", new ControlInputError("control-queue-overloaded", "control queue is full"), 429, "rate_limited", "control-queue-overloaded", "control queue is full"],
  ["control queue closed", new ControlInputError("control-queue-closed", "closed"), 503, "service_unavailable", "control-queue-closed", "closed"],
  ["adb failure", new AppManagementError("adb-failed", "Failure [INSTALL_FAILED_X] /data/app/..."), 502, "downstream_failure", "adb-failed", "adb command failed"],
  ["adb timeout", new AppManagementError("adb-timeout", "adb shell pm clear x timed out"), 502, "downstream_failure", "adb-timeout", "adb command timed out"],
  ["route conflict", new RoutePlaybackConflictError("route playback is closed"), 409, "conflict", undefined, "route playback is closed"],
  ["route location failure", new RoutePlaybackApplyError("geo fix: KO: bad", { cause: new Error("x") }), 502, "downstream_failure", undefined, "route location update failed"],
  ["replay validation", new SessionReplayValidationError("multiplier must be a number"), 400, "invalid_request", undefined, "multiplier must be a number"],
  ["replay conflict", new SessionReplayConflictError("session replay is already running"), 409, "conflict", undefined, "session replay is already running"],
  ["plain validation error", new Error("x must be between 0 and 1"), 400, "invalid_request", undefined, "x must be between 0 and 1"],
];

describe("toApiError", () => {
  test.each(rows)("%s", async (_name, error, status, code, reason, message) => {
    const apiError = toApiError(error);
    expect(apiError).toBeInstanceOf(ApiError);
    expect(apiError.status as number).toBe(status);
    expect(apiError.code).toBe(code as never);
    expect(apiError.reason).toBe(reason);
    expect(apiError.message).toMatch(message);
    expect(apiError.cause).toBe(error);
    // Every mapped failure is a valid shared ApiFailure on the wire.
    const body = parseApiFailure(await apiErrorResponse(apiError).json());
    expect(body.error).toEqual({ code: code as never, message: apiError.message, ...(reason ? { reason } : {}) });
  });

  test("an unexpected error falls back without echoing internals when the fallback is a server error", () => {
    const leaky = new Error("ENOENT: /home/user/secret");
    expect(toApiError(leaky, "internal_error")).toMatchObject({
      status: 500,
      code: "internal_error",
      message: "internal server error",
    });
    expect(toApiError("thrown string")).toMatchObject({ status: 400, message: "thrown string" });
  });

  test("passes an ApiError through unchanged", () => {
    const original = new ApiError(404, "not_found", "nope");
    expect(toApiError(original)).toBe(original);
  });
});
