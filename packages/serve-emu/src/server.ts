import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertValidToken } from "./access-policy.ts";
import {
  getAccessibilitySnapshot,
  type AccessibilitySnapshot,
} from "./accessibility.ts";
import { listAllDevices } from "./adb.ts";
import { loadDeviceGrid } from "./device-grid.ts";
import { createApiRouter } from "./api/router.ts";
import type {
  ApiDependencies,
  ApplyLocationOptions,
} from "./api/dependencies.ts";
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
} from "./emulator.ts";
import { getExecSnapshot } from "./exec.ts";
import type { Gesture } from "./input.ts";
import { JsonResponseTracker } from "./json-response.ts";
import { setEmulatorLocationAsync, type GeoFix } from "./location.ts";
import { stageMultipartUpload } from "./multipart-upload.ts";
import { readJsonLimited } from "./request-body.ts";
import {
  closeScrcpySession,
  startScrcpy,
  type ScrcpySession,
} from "./scrcpy.ts";
import { createRequestGate } from "./server/auth.ts";
import { createEmulatorRegistry } from "./server/emulators.ts";
import { buildHealthSnapshot } from "./server/health.ts";
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
import type { DeviceGridResponse } from "./shared/api-contracts.ts";
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
  const listDevices =
    dependencies.listDevices ?? listAllDevices;
  const emulators = createEmulatorRegistry({
    startEmulator: dependencies.startEmulator ?? startEmulator,
    stopEmulator: dependencies.stopEmulator ?? stopEmulator,
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

  const initialScrcpy = await openScrcpy(opts.serial, opts.signal);
  let initialContext: DeviceContext;
  try {
    initialContext = createContext(opts.serial, 0, initialScrcpy);
  } catch (err) {
    await closeScrcpySession(initialScrcpy);
    throw err;
  }
  const sessions = new DeviceSessionManager(initialContext);
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
  log(
    `scrcpy ready: ${initialScrcpy.meta.deviceName} • ${initialScrcpy.meta.codecId} • ${initialScrcpy.meta.width}×${initialScrcpy.meta.height}`,
  );

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

  const deviceGrid = async (
    context: DeviceContext,
  ): Promise<DeviceGridResponse> => {
    // One `adb devices` snapshot per request: running-AVD names resolve from
    // that same list, so the rows cannot disagree with each other.
    const grid = await loadDeviceGrid(context.serial, context.status, {
      listAllDevices: () => listDevices(),
      listAvds: () => availableAvds(),
      resolveRunningAvds: (devices) => listActiveAvds(devices),
    });
    sessions.assertPublished(context);
    return grid;
  };

  const readJsonBody = async (
    req: Request,
    maxBytes = MAX_JSON_BODY_BYTES,
    context?: DeviceContext,
    requireUsableContext = true,
  ): Promise<unknown> => {
    const value = await readJsonLimited(req, maxBytes);
    if (context) {
      if (requireUsableContext) sessions.assertCurrent(context);
      else sessions.assertPublished(context);
    }
    return value;
  };

  /**
   * Every handled /api failure, in the documented shape via toApiError.
   * Server-side failures are logged with the request's method and path and
   * the original error; the response carries only the public message.
   */
  const errorResponse = (
    err: unknown,
    req: Request,
    fallback: ApiErrorFallback = "invalid_request",
  ) => {
    const error = toApiError(err, fallback);
    if (error.status >= 500) {
      logApiFailure(req, error.status, error.message, err);
    }
    return apiErrorResponse(error);
  };

  /**
   * Runs device work for one session. The operation gets a signal that aborts
   * when that session ends (a device switch) or the client goes away, so its
   * adb process is killed instead of running to its timeout. Either way the
   * caller sees a 409 for the old session, not the abort error.
   */
  const runForContext = async <T>(
    context: DeviceContext,
    operation: (captured: DeviceContext, signal: AbortSignal) => Promise<T>,
    requestSignal?: AbortSignal,
  ): Promise<T> => {
    sessions.assertCurrent(context);
    const signal = requestSignal
      ? AbortSignal.any([context.signal, requestSignal])
      : context.signal;
    try {
      return await operation(context, signal);
    } finally {
      sessions.assertCurrent(context);
    }
  };

  const runForPublishedContext = async <T>(
    context: DeviceContext,
    operation: (captured: DeviceContext) => Promise<T>,
  ): Promise<T> => {
    sessions.assertPublished(context);
    const result = await operation(context);
    sessions.assertPublished(context);
    return result;
  };

  const readAccessibilitySnapshot = async (
    context: DeviceContext,
    cacheMs = 2_500,
  ) => {
    const snapshot = await context.readAccessibilitySnapshot(
      loadAccessibility,
      cacheMs,
    );
    sessions.assertCurrent(context);
    return snapshot;
  };

  const enqueueGesture = (
    context: DeviceContext,
    gesture: Gesture,
    source: string,
    record = true,
  ) => {
    sessions.assertCurrent(context);
    if (context.status !== "streaming") {
      throw new Error(`session is ${context.status}`);
    }
    const accepted = context.inputQueue.enqueue(gesture, { ...context.screen });
    if (record) context.recorder.recordGesture(accepted.gesture, source);
    return accepted;
  };

  /** The one place a location is applied, for REST and for session replay. */
  const applyLocation = async (
    context: DeviceContext,
    fix: GeoFix,
    options: ApplyLocationOptions,
  ) => {
    const ensureCurrent =
      options.ensureCurrent ?? (() => sessions.assertCurrent(context));
    ensureCurrent();
    context.route.stop();
    await setLocation(context.serial, fix, options.signal ?? context.signal);
    ensureCurrent();
    context.lastLocation = { ...fix, appliedAt: new Date().toISOString() };
    if (options.record ?? true) {
      context.recorder.recordLocation(fix, options.source);
    }
    return context.lastLocation;
  };

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
        const scrcpy = await openScrcpy(targetSerial, signal);
        try {
          return createContext(targetSerial, generation, scrcpy);
        } catch (err) {
          await closeScrcpySession(scrcpy);
          throw err;
        }
      },
      video.activate,
    );
    log(
      `scrcpy ready: ${context.scrcpy.meta.deviceName} • ${context.scrcpy.meta.codecId} • ${context.scrcpy.meta.width}×${context.scrcpy.meta.height}`,
    );
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
    sessions,
    readJsonBody,
    MAX_JSON_BODY_BYTES,
    MAX_ROUTE_BODY_BYTES,
    runForPublishedContext,
    runForContext,
    device,
    listDevices,
    deviceGrid,
    switchSession,
    launchEmulator: emulators.launchEmulator,
    listActiveAvds,
    killEmulator: emulators.killEmulator,
    readAccessibilitySnapshot,
    enqueueGesture,
    applyLocation,
    uploads: uploadEndpoints,
    responseMetrics,
  };

  const ws = createWebSocketEndpoint({
    sessions,
    recovery: video.recovery,
    enqueueGesture,
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
    stop,
  };
}
