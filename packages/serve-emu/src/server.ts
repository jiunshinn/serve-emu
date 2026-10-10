import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertValidToken } from "./access-policy.ts";
import {
  getAccessibilitySnapshot,
  type AccessibilitySnapshot,
} from "./accessibility.ts";
import { listAllDevices } from "./adb.ts";
import { createApiRouter } from "./api/router.ts";
import type { ApiDependencies } from "./api/dependencies.ts";
import { createDeviceService, type DeviceService } from "./device-service.ts";
import { apiErrorResponse } from "./api/api-error.ts";
import { toApiError, type ApiErrorFallback } from "./api/error-mapping.ts";
import { MAX_ROUTE_BODY_BYTES } from "./shared/route-limits.ts";
import { createApiRoutes } from "./api/routes/index.ts";
import { importMediaFile, installApk } from "./app-management.ts";
import { logApiFailure } from "./command-failure.ts";
import { ControlInputQueue } from "./control-input-queue.ts";
import {
  ActiveDeviceSession,
  DeviceSessionManager,
} from "./device-session-context.ts";
import {
  listAvds,
  listRunningAvds,
  startEmulator,
  stopEmulator,
  type StartEmulatorOpts,
} from "./emulator.ts";
import { getExecSnapshot } from "./exec.ts";
import { JsonResponseTracker } from "./json-response.ts";
import { setEmulatorLocationAsync, type GeoFix } from "./location.ts";
import { stageMultipartUpload } from "./multipart-upload.ts";
import {
  closeScrcpySession,
  startScrcpy,
  type ScrcpySession,
} from "./scrcpy.ts";
import { createRequestGate } from "./server/auth.ts";
import { createEmulatorRegistry } from "./server/emulators.ts";
import { buildHealthSnapshot } from "./server/health.ts";
import { createSessionServices } from "./server/session-services.ts";
import { serveStaticFile } from "./server/static.ts";
import type { Client, DeviceContext, WsData } from "./server/types.ts";
import {
  createVideoPipeline,
  RESET_SETTLE_MS,
  SOURCE_STALL_RESET_MS,
} from "./server/video.ts";
import {
  createUploadEndpoints,
  resolveUploadLimits,
} from "./server/uploads.ts";
import { createWebSocketEndpoint } from "./server/ws.ts";
import {
  SYSTEM_RECOVERY_WATCHDOG_CLOCK,
  type RecoveryWatchdogClock,
} from "./session-recovery-watchdog.ts";
import type { DeviceSelectionResponse } from "./shared/api-contracts.ts";
import {
  UploadManager,
  UploadManagerError,
  type UploadManagerOptions,
} from "./upload-manager.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dirname, "..", "dist", "ui");

export type ServerOpts = {
  serial: string;
  port: number;
  signal?: AbortSignal;
  /** Address to bind. Defaults to loopback (127.0.0.1). */
  host?: string;
  /**
   * Shared secret required on every request. When empty/undefined, auth is
   * disabled (intended only for loopback binds). Presented via bearer token,
   * the `semu_session` cookie, or a `token` query param.
   */
  token?: string;
  /**
   * Extra Host names accepted while auth is disabled, for reverse proxies or
   * LAN host names. IP literals, `localhost`, and `host` are always accepted.
   */
  allowedHosts?: readonly string[];
  maxFps?: number;
  bitRate?: number;
  maxSize?: number;
  keyFrameInterval?: number;
  repeatFrameMs?: number;
  maxApkUploadBytes?: number;
  maxMediaUploadBytes?: number;
  maxActiveUploads?: number;
  maxQueuedUploads?: number;
  uploadQueueTimeoutMs?: number;
  /**
   * Launch settings for emulators started through /api/avds/start, the same
   * ones the CLI uses for --avd: the emulator binary, `-gpu`, and the window.
   */
  emulator?: Pick<StartEmulatorOpts, "emulatorPath" | "gpu" | "window">;
};

export const DEFAULT_HOST = "127.0.0.1";
export {
  DEFAULT_MAX_ACTIVE_UPLOADS,
  DEFAULT_MAX_APK_UPLOAD_BYTES,
  DEFAULT_MAX_MEDIA_UPLOAD_BYTES,
  DEFAULT_MAX_QUEUED_UPLOADS,
  DEFAULT_UPLOAD_QUEUE_TIMEOUT_MS,
} from "./server/uploads.ts";

const MAX_JSON_BODY_BYTES = 8 * 1024;

export type ServerDependencies = {
  openScrcpy?: (serial: string, signal?: AbortSignal) => Promise<ScrcpySession>;
  serve?: typeof Bun.serve;
  listDevices?: typeof listAllDevices;
  startEmulator?: typeof startEmulator;
  stopEmulator?: typeof stopEmulator;
  listRunningAvds?: typeof listRunningAvds;
  listAvds?: typeof listAvds;
  /** Device commands used by the API routes (screenshot, settings, apps). */
  deviceService?: DeviceService;
  /** Startup and session lines ("scrcpy ready: …"); console.log by default. */
  log?: (line: string) => void;
  loadAccessibility?: (
    serial: string,
    signal: AbortSignal,
  ) => Promise<AccessibilitySnapshot>;
  setLocation?: (
    serial: string,
    fix: GeoFix,
    signal: AbortSignal,
  ) => Promise<void>;
  createInputQueue?: (session: ScrcpySession) => ControlInputQueue;
  recoveryClock?: RecoveryWatchdogClock;
  createUploadManager?: (options: UploadManagerOptions) => UploadManager;
  stageMultipartUpload?: typeof stageMultipartUpload;
  installApk?: typeof installApk;
  importMediaFile?: typeof importMediaFile;
  /** Directory the bundled UI is served from; tests point it at a temp dir. */
  uiDir?: string;
};

/**
 * Every handled /api failure, in the documented shape via toApiError.
 * Server-side failures are logged with the request's method and path and
 * the original error; the response carries only the public message.
 */
function errorResponse(
  err: unknown,
  req: Request,
  fallback: ApiErrorFallback = "invalid_request",
) {
  const error = toApiError(err, fallback);
  if (error.status >= 500) {
    logApiFailure(req, error.status, error.message, err);
  }
  return apiErrorResponse(error);
}

export async function startServer(
  opts: ServerOpts,
  dependencies: ServerDependencies = {},
) {
  // The token is written into the session cookie and compared against query
  // and header values verbatim, so it must stay within the safe character set.
  if (opts.token) assertValidToken(opts.token);
  const openScrcpy =
    dependencies.openScrcpy ??
    ((serial: string, signal?: AbortSignal) =>
      startScrcpy({
        serial,
        signal,
        maxFps: opts.maxFps,
        bitRate: opts.bitRate,
        maxSize: opts.maxSize,
        keyFrameInterval: opts.keyFrameInterval,
        repeatFrameMs: opts.repeatFrameMs,
      }));
  const serve = dependencies.serve ?? Bun.serve;
  const log = dependencies.log ?? ((line: string) => console.log(line));
  const listDevices = dependencies.listDevices ?? listAllDevices;
  // The CLI's emulator settings, for launches through /api/avds/start and
  // the AVD list (the same binary as --avd).
  const emulatorSettings = opts.emulator ?? {};
  const emulators = createEmulatorRegistry({
    startEmulator: dependencies.startEmulator ?? startEmulator,
    stopEmulator: dependencies.stopEmulator ?? stopEmulator,
    settings: emulatorSettings,
  });
  const listActiveAvds = dependencies.listRunningAvds ?? listRunningAvds;
  const availableAvds = dependencies.listAvds ?? listAvds;
  const loadAccessibility =
    dependencies.loadAccessibility ??
    ((serial: string, signal: AbortSignal) =>
      getAccessibilitySnapshot(serial, { signal }));
  const setLocation =
    dependencies.setLocation ??
    ((serial: string, fix: GeoFix, signal: AbortSignal) =>
      setEmulatorLocationAsync(serial, fix, { signal }));
  const device = dependencies.deviceService ?? createDeviceService();
  const createInputQueue =
    dependencies.createInputQueue ??
    ((session: ScrcpySession) =>
      new ControlInputQueue({ socket: session.controlSocket }));
  const recoveryClock =
    dependencies.recoveryClock ?? SYSTEM_RECOVERY_WATCHDOG_CLOCK;
  const limits = resolveUploadLimits(opts);
  const uploads = (
    dependencies.createUploadManager ??
    ((options: UploadManagerOptions) => new UploadManager(options))
  )({
    maxActive: limits.maxActiveUploads,
    maxQueued: limits.maxQueuedUploads,
    queueTimeoutMs: limits.uploadQueueTimeoutMs,
  });

  const uiDir = dependencies.uiDir ?? UI_DIR;
  const host = opts.host ?? DEFAULT_HOST;
  const gate = createRequestGate({
    token: opts.token,
    host,
    allowedHosts: opts.allowedHosts,
  });

  const createContext = (
    serial: string,
    generation: number,
    scrcpy: ScrcpySession,
  ): DeviceContext => {
    const context = new ActiveDeviceSession<Client>({
      serial,
      generation,
      scrcpy,
      applyLocation: setLocation,
      inputQueue: createInputQueue(scrcpy),
    });
    context.registerCleanup(() =>
      uploads.cancelGeneration(
        generation,
        new UploadManagerError(
          "device-session-changed",
          `device session ${generation} is no longer active`,
          { serial, generation },
        ),
      ),
    );
    return context;
  };

  /** Opens scrcpy and wraps it in a session; scrcpy closes if that fails. */
  const openContext = async (
    serial: string,
    generation: number,
    signal?: AbortSignal,
  ): Promise<DeviceContext> => {
    const scrcpy = await openScrcpy(serial, signal);
    try {
      return createContext(serial, generation, scrcpy);
    } catch (err) {
      await closeScrcpySession(scrcpy);
      throw err;
    }
  };
  const logReady = ({ scrcpy: { meta } }: DeviceContext) =>
    log(
      `scrcpy ready: ${meta.deviceName} • ${meta.codecId} • ${meta.width}×${meta.height}`,
    );

  const sessions = new DeviceSessionManager(
    await openContext(opts.serial, 0, opts.signal),
  );
  const responseMetrics = new JsonResponseTracker([
    "health",
    "sessionPage",
    "sessionExport",
  ] as const);
  let stopRequested = false;
  const video = createVideoPipeline({
    sessions,
    clock: recoveryClock,
    isStopping: () => stopRequested,
  });
  logReady(sessions.current);

  const health = (context = sessions.current) => {
    const now = recoveryClock.now();
    return buildHealthSnapshot(context, {
      nowMs: now,
      recovery: video.recovery(context)?.snapshot(now) ?? null,
      idleResetBackoffMs: RESET_SETTLE_MS,
      baseStallResetMs: SOURCE_STALL_RESET_MS,
      responseMetrics: responseMetrics.snapshot(),
      uploads: uploads.snapshot(),
      executor: getExecSnapshot(),
    });
  };

  const services = createSessionServices({
    sessions,
    maxJsonBodyBytes: MAX_JSON_BODY_BYTES,
    loadAccessibility,
    setLocation,
    listDevices,
    listAvds: () => availableAvds(emulatorSettings.emulatorPath),
    listRunningAvds: listActiveAvds,
  });

  const uploadEndpoints = createUploadEndpoints({
    uploads,
    sessions,
    maxApkUploadBytes: limits.maxApkUploadBytes,
    maxMediaUploadBytes: limits.maxMediaUploadBytes,
    stageUpload: dependencies.stageMultipartUpload ?? stageMultipartUpload,
    installApk: dependencies.installApk ?? installApk,
    importMediaFile: dependencies.importMediaFile ?? importMediaFile,
  });

  const switchSession = async (
    serial: string,
  ): Promise<DeviceSelectionResponse> => {
    // Uploads for the previous generation are cancelled by its context
    // cleanup (see createContext) once the switch commits. Cancelling here,
    // before the candidate is prepared, would strand the still-current
    // session's uploads whenever the switch fails.
    const context = await sessions.switch(
      serial,
      async (targetSerial, generation, signal) => {
        const device = (await listDevices()).find(
          (candidate) => candidate.serial === targetSerial,
        );
        if (signal.aborted) {
          throw signal.reason instanceof Error
            ? signal.reason
            : new Error("device switch aborted");
        }
        if (!device) throw new Error(`Unknown adb device "${targetSerial}".`);
        if (device.state !== "device") {
          throw new Error(`${targetSerial} is ${device.state}, not ready.`);
        }
        return openContext(targetSerial, generation, signal);
      },
      video.activate,
    );
    logReady(context);
    return {
      ok: true,
      serial: context.serial,
      generation: context.generation,
      device: context.scrcpy.meta.deviceName,
    };
  };

  try {
    video.activate(sessions.current);
  } catch (err) {
    stopRequested = true;
    await sessions.close("server startup failed");
    throw err;
  }

  const apiRouter = createApiRouter(createApiRoutes());
  const apiServices: Omit<
    ApiDependencies,
    "requestContext" | "srv" | "errorResponse"
  > = {
    ...services,
    sessions,
    MAX_JSON_BODY_BYTES,
    MAX_ROUTE_BODY_BYTES,
    device,
    listDevices,
    switchSession,
    launchEmulator: emulators.launchEmulator,
    listActiveAvds,
    killEmulator: emulators.killEmulator,
    uploads: uploadEndpoints,
    responseMetrics,
  };

  const ws = createWebSocketEndpoint({
    sessions,
    recovery: video.recovery,
    enqueueGesture: services.enqueueGesture,
    enqueueVideoReset: video.enqueueVideoReset,
    health,
  });

  const serverOptions: Parameters<typeof Bun.serve<WsData>>[0] = {
    port: opts.port,
    hostname: host,
    maxRequestBodySize: limits.maxRequestBodySize,
    async fetch(req, srv) {
      const requestContext = sessions.current;
      const url = new URL(req.url);

      const rejected = gate(req, url);
      if (rejected) return rejected;

      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        const apiResponse = await apiRouter.handle(req, {
          ...apiServices,
          requestContext,
          srv,
          errorResponse: (err: unknown, fallback?: ApiErrorFallback) =>
            errorResponse(err, req, fallback),
        });
        if (apiResponse) return apiResponse;
      }

      if (url.pathname === "/health") {
        return responseMetrics.response("health", health(requestContext), {
          status: requestContext.status === "streaming" ? 200 : 503,
        });
      }

      if (url.pathname === "/ws") {
        return ws.upgrade(req, url, srv, requestContext);
      }

      return serveStaticFile(uiDir, url.pathname);
    },
    websocket: ws.handlers,
  };

  let server: ReturnType<typeof Bun.serve<WsData>>;
  try {
    server = serve<WsData>(serverOptions);
  } catch (err) {
    stopRequested = true;
    await sessions.close("server startup failed");
    await uploads.close(
      new UploadManagerError("closed", "server startup failed", {
        serial: sessions.current.serial,
        generation: sessions.current.generation,
      }),
    );
    throw err;
  }

  let stopTask: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    if (stopTask) return stopTask;
    stopRequested = true;
    server.stop(true);
    const context = sessions.current;
    const error = new UploadManagerError("closed", "server is stopping", {
      serial: context.serial,
      generation: context.generation,
    });
    stopTask = Promise.all([
      emulators.shutdown(),
      sessions.close("server stopping"),
      uploads.close(error),
    ]).then(() => {});
    return stopTask;
  };

  return {
    server,
    get session(): ScrcpySession | null {
      const context = sessions.current;
      return context.signal.aborted ? null : context.scrcpy;
    },
    /**
     * The device this server still depends on: the published session's
     * serial, even after that session failed, or null while stopping or once
     * a client stopped that device on purpose.
     */
    get deviceSerial(): string | null {
      const context = sessions.current;
      return stopRequested || context.stoppedByClient ? null : context.serial;
    },
    stop,
  };
}
