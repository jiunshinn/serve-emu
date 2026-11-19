import type { importMediaFile, installApk } from "../app-management.ts";
import type { DeviceSessionManager } from "../device-session-context.ts";
import {
  MultipartUploadError,
  type stageMultipartUpload,
  type StagedMultipartFile,
} from "../multipart-upload.ts";
import { MAX_ROUTE_BODY_BYTES } from "../shared/route-limits.ts";
import {
  MAX_UPLOAD_QUEUE_TIMEOUT_MS,
  UploadManagerError,
  type UploadContext,
  type UploadManager,
} from "../upload-manager.ts";
import type { DeviceContext } from "./types.ts";

export const DEFAULT_MAX_APK_UPLOAD_BYTES = 512 * 1024 * 1024;
export const DEFAULT_MAX_MEDIA_UPLOAD_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_MAX_ACTIVE_UPLOADS = 2;
export const DEFAULT_MAX_QUEUED_UPLOADS = 4;
export const DEFAULT_UPLOAD_QUEUE_TIMEOUT_MS = 5_000;
const MULTIPART_BODY_OVERHEAD_BYTES = 1024 * 1024;

function serverLimit(
  value: number | undefined,
  fallback: number,
  name: string,
  allowZero = false,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < (allowZero ? 0 : 1)) {
    throw new Error(
      `${name} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`,
    );
  }
  return resolved;
}

/**
 * The upload limits with their defaults applied, and the request body size
 * the server must accept for them. Throws on a limit that is out of range.
 */
export function resolveUploadLimits(opts: {
  maxApkUploadBytes?: number;
  maxMediaUploadBytes?: number;
  maxActiveUploads?: number;
  maxQueuedUploads?: number;
  uploadQueueTimeoutMs?: number;
}) {
  const maxApkUploadBytes = serverLimit(
    opts.maxApkUploadBytes,
    DEFAULT_MAX_APK_UPLOAD_BYTES,
    "maxApkUploadBytes",
  );
  const maxMediaUploadBytes = serverLimit(
    opts.maxMediaUploadBytes,
    DEFAULT_MAX_MEDIA_UPLOAD_BYTES,
    "maxMediaUploadBytes",
  );
  const maxActiveUploads = serverLimit(
    opts.maxActiveUploads,
    DEFAULT_MAX_ACTIVE_UPLOADS,
    "maxActiveUploads",
  );
  const maxQueuedUploads = serverLimit(
    opts.maxQueuedUploads,
    DEFAULT_MAX_QUEUED_UPLOADS,
    "maxQueuedUploads",
    true,
  );
  const uploadQueueTimeoutMs = serverLimit(
    opts.uploadQueueTimeoutMs,
    DEFAULT_UPLOAD_QUEUE_TIMEOUT_MS,
    "uploadQueueTimeoutMs",
    true,
  );
  if (uploadQueueTimeoutMs > MAX_UPLOAD_QUEUE_TIMEOUT_MS) {
    throw new Error(
      `uploadQueueTimeoutMs must be at most ${MAX_UPLOAD_QUEUE_TIMEOUT_MS}`,
    );
  }
  const maxUploadFileBytes = Math.max(maxApkUploadBytes, maxMediaUploadBytes);
  if (
    maxUploadFileBytes >
    Number.MAX_SAFE_INTEGER - MULTIPART_BODY_OVERHEAD_BYTES * 2
  ) {
    throw new Error("upload byte limit is too large");
  }
  const maxRequestBodySize = Math.max(
    maxUploadFileBytes + MULTIPART_BODY_OVERHEAD_BYTES * 2,
    MAX_ROUTE_BODY_BYTES,
  );
  return {
    maxApkUploadBytes,
    maxMediaUploadBytes,
    maxActiveUploads,
    maxQueuedUploads,
    uploadQueueTimeoutMs,
    maxRequestBodySize,
  };
}

/** Multipart uploads staged to disk and then applied to a session's device. */
export type UploadEndpoints = {
  /** Stages the `apk` field and installs it; resolves with the install result. */
  install(context: DeviceContext, req: Request): Promise<unknown>;
  /** Stages the `file` field and imports it into the device's media. */
  importFile(context: DeviceContext, req: Request): Promise<unknown>;
};

export function createUploadEndpoints(deps: {
  uploads: UploadManager;
  sessions: DeviceSessionManager<DeviceContext>;
  maxApkUploadBytes: number;
  maxMediaUploadBytes: number;
  stageUpload: typeof stageMultipartUpload;
  installApk: typeof installApk;
  importMediaFile: typeof importMediaFile;
}): UploadEndpoints {
  const {
    uploads,
    sessions,
    stageUpload,
    installApk: installStagedApk,
    importMediaFile: importStagedMedia,
  } = deps;

  const runUpload = async (
    context: DeviceContext,
    req: Request,
    options: {
      fieldName: "apk" | "file";
      maxFileBytes: number;
      action: (
        serial: string,
        file: StagedMultipartFile,
        signal: AbortSignal,
      ) => Promise<unknown>;
    },
  ) => {
    const uploadContext: UploadContext = {
      serial: context.serial,
      generation: context.generation,
    };
    return uploads.run(
      {
        context: uploadContext,
        requestSignal: req.signal,
        sessionSignal: context.signal,
      },
      async ({ context: acceptedContext, signal }) => {
        const staged = await stageUpload(req, {
          fieldName: options.fieldName,
          maxFileBytes: options.maxFileBytes,
          maxBodyBytes: options.maxFileBytes + MULTIPART_BODY_OVERHEAD_BYTES,
          signal,
        });
        try {
          sessions.assertCurrent(context);
          if (
            acceptedContext.serial !== context.serial ||
            acceptedContext.generation !== context.generation
          ) {
            throw new UploadManagerError(
              "device-session-changed",
              "device session changed during upload",
              acceptedContext,
            );
          }
          return await options.action(context.serial, staged, signal);
        } finally {
          try {
            await staged.cleanup();
          } catch (error) {
            throw new MultipartUploadError(
              "upload-cleanup-failed",
              "failed to clean up multipart upload",
              { cause: error },
            );
          }
        }
      },
    );
  };

  return {
    install: (context, req) =>
      runUpload(context, req, {
        fieldName: "apk",
        maxFileBytes: deps.maxApkUploadBytes,
        action: (serial, file, signal) =>
          installStagedApk(serial, file, { signal }),
      }),
    importFile: (context, req) =>
      runUpload(context, req, {
        fieldName: "file",
        maxFileBytes: deps.maxMediaUploadBytes,
        action: (serial, file, signal) =>
          importStagedMedia(serial, file, { signal }),
      }),
  };
}
