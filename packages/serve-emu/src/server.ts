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
import { avdManager, type AvdManager } from "./avd-manager.ts";
import { createDeviceService, type DeviceService } from "./device-service.ts";
import { ApiError, apiErrorResponse } from "./api/api-error.ts";
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
  SCRCPY_DEFAULTS,
  startScrcpy,
  type ScrcpySession,
} from "./scrcpy.ts";
import { createRequestGate } from "./server/auth.ts";
import { startContentionProbe } from "./server/contention.ts";
import { createDeviceRecovery } from "./server/device-recovery.ts";
import { createEmulatorRegistry } from "./server/emulators.ts";
import { buildHealthSnapshot } from "./server/health.ts";
import { createSessionServices } from "./server/session-services.ts";
import { isServicePath, splitDevicePath } from "./server/device-path.ts";
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
import type {
  DeviceSelectionResponse,
  StreamQuality,
  StreamQualityResponse,
} from "./shared/api-contracts.ts";
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
  /**
   * Check the device for other scrcpy sessions in the background (#76).
   * The CLI turns it on; off, `/health` reports `contention: null`.
   */
  probeDeviceContention?: boolean;
  /** Devices streamed at once: the selected one plus `/d/<serial>/` ones. */
  maxDevices?: number;
  /** A `/d/<serial>/` stream with no viewer or request closes after this. */
  idleDeviceMs?: number;
};

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_MAX_DEVICES = 4;
const DEFAULT_IDLE_DEVICE_MS = 60_000;
const IDLE_SWEEP_MS = 5_000;
export {
  DEFAULT_MAX_ACTIVE_UPLOADS,
  DEFAULT_MAX_APK_UPLOAD_BYTES,
  DEFAULT_MAX_MEDIA_UPLOAD_BYTES,
  DEFAULT_MAX_QUEUED_UPLOADS,
  DEFAULT_UPLOAD_QUEUE_TIMEOUT_MS,
} from "./server/uploads.ts";

const MAX_JSON_BODY_BYTES = 8 * 1024;

export type ServerDependencies = {
  openScrcpy?: (
    serial: string,
    signal?: AbortSignal,
    quality?: StreamQuality,
  ) => Promise<ScrcpySession>;
  serve?: typeof Bun.serve;
  listDevices?: typeof listAllDevices;
  startEmulator?: typeof startEmulator;
  stopEmulator?: typeof stopEmulator;
  listRunningAvds?: typeof listRunningAvds;
  listAvds?: typeof listAvds;
  /** Device commands used by the API routes (screenshot, settings, apps). */
  deviceService?: DeviceService;
  /** Host AVD catalog and creation used by the Add emulator dialog. */
  avds?: AvdManager;
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
  waitForDeviceRetry?: (ms: number, signal: AbortSignal) => Promise<void>;
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
    ((serial: string, signal?: AbortSignal, quality?: StreamQuality) =>
      startScrcpy({
        serial,
        signal,
        maxFps: quality?.maxFps ?? opts.maxFps,
        bitRate: quality?.bitRate ?? opts.bitRate,
        maxSize: quality?.maxSize ?? opts.maxSize,
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
    previousRecorder?: DeviceContext["recorder"],
  ): DeviceContext => {
    const context = new ActiveDeviceSession<Client>({
      serial,
      generation,
      scrcpy,
      applyLocation: setLocation,
      inputQueue: createInputQueue(scrcpy),
      recorder: previousRecorder?.copyHistory(),
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
    previousRecorder?: DeviceContext["recorder"],
    quality?: StreamQuality,
  ): Promise<DeviceContext> => {
    const scrcpy = await openScrcpy(serial, signal, quality);
    try {
      return createContext(serial, generation, scrcpy, previousRecorder);
    } catch (err) {
      await closeScrcpySession(scrcpy);
      throw err;
    }
  };
  const logReady = ({ scrcpy: { meta } }: DeviceContext) =>
    log(
      `scrcpy ready: ${meta.deviceName} • ${meta.codecId} • ${meta.width}×${meta.height}`,
    );

  const responseMetrics = new JsonResponseTracker([
    "health",
    "sessionPage",
    "sessionExport",
  ] as const);
  let stopRequested = false;
  const lifetime = new AbortController();
  // Uploads are cancelled by generation, so every device's sessions draw
  // generations from this one sequence.
  let lastGeneration = 0;
  const allocateGeneration = () => ++lastGeneration;
  const defaultQuality: StreamQuality = {
    maxSize: opts.maxSize ?? SCRCPY_DEFAULTS.maxSize,
    maxFps: opts.maxFps ?? SCRCPY_DEFAULTS.maxFps,
    bitRate: opts.bitRate ?? SCRCPY_DEFAULTS.bitRate,
  };
  const maxDevices = opts.maxDevices ?? DEFAULT_MAX_DEVICES;
  if (!Number.isInteger(maxDevices) || maxDevices < 1) {
    throw new TypeError("maxDevices must be a positive integer");
  }
  const idleDeviceMs = opts.idleDeviceMs ?? DEFAULT_IDLE_DEVICE_MS;
  /** Devices streamed under `/d/<serial>/`, besides the selected one. */
  const pinned = new Map<
    string,
    { slot: Promise<DeviceSlot>; ready: DeviceSlot | null }
  >();

  type DeviceSlot = ReturnType<typeof createSlot>;
  /**
   * One device's session manager, recovery, video, and endpoints. The
   * selected device's slot has no `pinnedSerial` and can switch devices; a
   * `/d/<serial>/` slot stays on its serial.
   */
  function createSlot(initial: DeviceContext, pinnedSerial: string | null) {
    const sessions = new DeviceSessionManager(initial, allocateGeneration);
    let closing = false;
    let quality: StreamQuality = { ...defaultQuality };
    const deviceRecovery = createDeviceRecovery({
      current: () => sessions.current,
      reopen: async (failed) => {
        const context = await sessions.switch(
          failed.serial,
          (serial, generation, signal) =>
            prepareSelection(serial, generation, signal, failed.recorder, quality),
          activate,
          failed,
        );
        logReady(context);
      },
      wait: dependencies.waitForDeviceRetry,
    });
    const video = createVideoPipeline({
      sessions,
      clock: recoveryClock,
      isStopping: () => stopRequested || closing,
      onTerminated: deviceRecovery.start,
    });
    // Activation starts a session's video and, for the CLI, its contention probe.
    const activate = (context: DeviceContext) => {
      video.activate(context);
      if (opts.probeDeviceContention) {
        startContentionProbe(context, { device, clock: recoveryClock });
      }
    };

    const health = (context = sessions.current) => {
      const now = recoveryClock.now();
      return buildHealthSnapshot(context, {
        nowMs: now,
        recovery: video.recovery(context)?.snapshot(now) ?? null,
        idleResetBackoffMs: RESET_SETTLE_MS,
        baseStallResetMs: SOURCE_STALL_RESET_MS,
        responseMetrics: responseMetrics.snapshot(),
        recovering: deviceRecovery.isRecovering(context),
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

    const assertCanSwitch = () => {
      if (pinnedSerial !== null) {
        throw new ApiError(
          409,
          "conflict",
          `This stream stays on ${pinnedSerial}; select devices without the /d/ prefix`,
          { reason: "device-pinned" },
        );
      }
    };
    const switchSession = async (
      serial: string,
    ): Promise<DeviceSelectionResponse> => {
      assertCanSwitch();
      // Uploads for the previous generation are cancelled by its context
      // cleanup (see createContext) once the switch commits. Cancelling here,
      // before the candidate is prepared, would strand the still-current
      // session's uploads whenever the switch fails.
      // Quality belongs to a device, so a newly selected one starts at defaults.
      // Reselecting the streaming device opens nothing and keeps its quality.
      const next = { ...defaultQuality };
      let reopened = false;
      const context = await sessions.switch(
        serial,
        (target, generation, signal) => {
          reopened = true;
          return prepareSelection(target, generation, signal, undefined, next);
        },
        activate,
      );
      if (reopened) quality = next;
      logReady(context);
      // The selected device now streams here; one scrcpy per device.
      void closePinned(context.serial, "device selected");
      return {
        ok: true,
        serial: context.serial,
        generation: context.generation,
        device: context.scrcpy.meta.deviceName,
      };
    };

    const qualityResponse = (context: DeviceContext): StreamQualityResponse => ({
      ok: true,
      serial: context.serial,
      generation: context.generation,
      quality: { ...quality },
    });
    const setStreamQuality = async (
      context: DeviceContext,
      patch: Partial<StreamQuality>,
    ): Promise<StreamQualityResponse> => {
      sessions.assertPublished(context);
      const next = { ...quality, ...patch };
      const switched = await sessions.switch(
        context.serial,
        (serial, generation, signal) =>
          prepareSelection(serial, generation, signal, context.recorder, next),
        // Publish the quality with its stream: a later patch merges onto it.
        (published) => {
          activate(published);
          quality = next;
        },
        undefined,
        {
          context,
          when: () =>
            context.status !== "streaming" ||
            quality.maxSize !== next.maxSize ||
            quality.maxFps !== next.maxFps ||
            quality.bitRate !== next.bitRate,
        },
      );
      if (switched !== context) logReady(switched);
      return qualityResponse(switched);
    };

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
      avds: dependencies.avds ?? avdManager,
      switchSession,
      assertCanSwitch,
      streamQuality: qualityResponse,
      setStreamQuality,
      launchEmulator: emulators.launchEmulator,
      listActiveAvds,
      killEmulator: async (serial: string) => {
        await stopOtherStreams(serial, sessions);
        return emulators.killEmulator(serial);
      },
      uploads: uploadEndpoints,
      responseMetrics,
    };

    const ws = createWebSocketEndpoint({
      sessions,
      join: video.join,
      enqueueGesture: services.enqueueGesture,
      enqueueVideoReset: video.enqueueVideoReset,
      health,
    });

    return {
      sessions,
      deviceRecovery,
      health,
      apiServices,
      ws,
      inFlight: 0,
      lastActiveMs: Date.now(),
      activate: () => activate(sessions.current),
      /** Nothing watches or uses this device: no socket, request, or job. */
      idle(): boolean {
        const context = sessions.current;
        return (
          this.inFlight === 0 &&
          context.clients.size === 0 &&
          context.logcat.snapshot().subscribers === 0 &&
          context.route.snapshot().status !== "running" &&
          !context.recorder.isReplaying
        );
      },
      async close(reason: string) {
        closing = true;
        deviceRecovery.stop();
        await sessions.close(reason);
      },
    };
  }

  async function prepareSelection(
    targetSerial: string,
    generation: number,
    signal: AbortSignal,
    previousRecorder?: DeviceContext["recorder"],
    quality?: StreamQuality,
  ) {
    const device = (await listDevices({ signal })).find(
      (candidate) => candidate.serial === targetSerial,
    );
    signal.throwIfAborted();
    if (!device) throw new Error(`Unknown adb device "${targetSerial}".`);
    if (device.state !== "device") {
      throw new Error(`${targetSerial} is ${device.state}, not ready.`);
    }
    return openContext(targetSerial, generation, signal, previousRecorder, quality);
  }

  const openPinned = async (serial: string): Promise<DeviceSlot> => {
    const signal = lifetime.signal;
    const device = (await listDevices({ signal })).find(
      (candidate) => candidate.serial === serial,
    );
    if (!device) {
      throw new ApiError(404, "not_found", "Unknown adb device", {
        reason: "unknown-device",
      });
    }
    if (device.state !== "device") {
      throw new ApiError(409, "conflict", `Device is ${device.state}, not ready`, {
        reason: "device-not-ready",
      });
    }
    let context: DeviceContext;
    try {
      context = await openContext(serial, allocateGeneration(), signal);
    } catch (cause) {
      throw new ApiError(503, "service_unavailable", "Could not start the device stream", {
        cause,
        reason: "device-open-failed",
      });
    }
    const slot = createSlot(context, serial);
    if (stopRequested) {
      await slot.close("server stopping");
      throw new ApiError(503, "service_unavailable", "Server is stopping");
    }
    try {
      slot.activate();
    } catch (cause) {
      await slot.close("device session activation failed");
      throw new ApiError(503, "service_unavailable", "Could not start the device stream", {
        cause,
        reason: "device-open-failed",
      });
    }
    logReady(context);
    return slot;
  };

  /** The slot streaming `serial`, opening one on first use. */
  const resolveSlot = (serial: string): Promise<DeviceSlot> => {
    if (primary.sessions.current.serial === serial) return Promise.resolve(primary);
    const existing = pinned.get(serial);
    if (existing) return existing.slot;
    if (stopRequested) {
      return Promise.reject(
        new ApiError(503, "service_unavailable", "Server is stopping"),
      );
    }
    if (pinned.size + 1 >= maxDevices) {
      return Promise.reject(
        new ApiError(
          503,
          "service_unavailable",
          `serve-emu streams at most ${maxDevices} devices at once`,
          { reason: "device-limit" },
        ),
      );
    }
    const entry = { slot: openPinned(serial), ready: null as DeviceSlot | null };
    pinned.set(serial, entry);
    entry.slot.then(
      (slot) => {
        entry.ready = slot;
      },
      () => {
        if (pinned.get(serial) === entry) pinned.delete(serial);
      },
    );
    return entry.slot;
  };

  /**
   * Before an emulator is killed through `caller`, stops the other slots
   * streaming it, so the selected one counts as stopped by a client.
   */
  const stopOtherStreams = async (
    serial: string,
    caller: DeviceSessionManager<DeviceContext>,
  ) => {
    const selected = primary.sessions;
    if (selected !== caller && selected.current.serial === serial) {
      await selected.stop(selected.current, "current emulator stopped", {
        byClient: true,
      });
    }
    const entry = pinned.get(serial);
    if (entry?.ready && entry.ready.sessions !== caller) {
      await closePinned(serial, "emulator stopped");
    }
  };

  /** Closes still in progress; stop waits for them too. */
  const closingSlots = new Set<Promise<void>>();
  const closePinned = (serial: string, reason: string): Promise<void> => {
    const entry = pinned.get(serial);
    if (!entry) return Promise.resolve();
    pinned.delete(serial);
    const task: Promise<void> = entry.slot
      .then((slot) => slot.close(reason), () => {})
      .catch((err: unknown) => log(`closing ${serial} failed: ${String(err)}`))
      .finally(() => closingSlots.delete(task));
    closingSlots.add(task);
    return task;
  };

  const idleSweep = setInterval(() => {
    const now = Date.now();
    for (const [serial, { ready: slot }] of pinned) {
      if (!slot) continue;
      if (!slot.idle()) slot.lastActiveMs = now;
      else if (now - slot.lastActiveMs >= idleDeviceMs) {
        void closePinned(serial, "no viewers");
      }
    }
  }, Math.min(idleDeviceMs, IDLE_SWEEP_MS));
  idleSweep.unref?.();

  const primary = createSlot(
    await openContext(opts.serial, lastGeneration, opts.signal).catch(
      (err: unknown) => {
        clearInterval(idleSweep);
        throw err;
      },
    ),
    null,
  );
  const sessions = primary.sessions;
  logReady(sessions.current);

  try {
    primary.activate();
  } catch (err) {
    stopRequested = true;
    clearInterval(idleSweep);
    primary.deviceRecovery.stop();
    await sessions.close("server startup failed");
    throw err;
  }

  const apiRouter = createApiRouter(createApiRoutes());

  /** Routes a request, with any `/d/<serial>` prefix removed, to a slot. */
  const routeToSlot = async (
    slot: DeviceSlot,
    requestContext: DeviceContext,
    req: Request,
    url: URL,
    path: string,
    srv: Bun.Server<WsData>,
  ): Promise<Response> => {
    if (path === "/api" || path.startsWith("/api/")) {
      const apiResponse = await apiRouter.handle(withPathname(req, url, path), {
        ...slot.apiServices,
        requestContext,
        srv,
        errorResponse: (err: unknown, fallback?: ApiErrorFallback) =>
          errorResponse(err, req, fallback),
      });
      if (apiResponse) return apiResponse;
    }

    if (path === "/health") {
      return responseMetrics.response("health", slot.health(requestContext), {
        status: requestContext.status === "streaming" ? 200 : 503,
      });
    }

    if (path === "/ws") {
      return slot.ws.upgrade(req, url, srv, requestContext);
    }

    return serveStaticFile(uiDir, path);
  };

  const serverOptions: Parameters<typeof Bun.serve<WsData>>[0] = {
    port: opts.port,
    hostname: host,
    maxRequestBodySize: limits.maxRequestBodySize,
    async fetch(req, srv) {
      const requestContext = sessions.current;
      const url = new URL(req.url);

      const rejected = gate(req, url);
      if (rejected) return rejected;

      const target = splitDevicePath(url.pathname);
      if (target?.serial === null) {
        return routeToSlot(primary, requestContext, req, url, url.pathname, srv);
      }
      // A device's own UI is the same page; it finds its prefix in the URL.
      if (target && (target.path === "/" || target.path === "/index.html")) {
        return serveStaticFile(uiDir, "/");
      }
      if (!target || !isServicePath(target.path)) {
        return new Response("not found", { status: 404 });
      }

      let slot: DeviceSlot;
      try {
        slot = await resolveSlot(target.serial);
        // The selected device may have switched away while this resolved.
        if (slot.sessions.current.serial !== target.serial) {
          slot = await resolveSlot(target.serial);
        }
        if (slot.sessions.current.serial !== target.serial) {
          throw new ApiError(409, "conflict", "device session changed", {
            reason: "session-changed",
          });
        }
      } catch (err) {
        return errorResponse(err, req, "internal_error");
      }
      slot.inFlight++;
      try {
        return await routeToSlot(
          slot,
          slot.sessions.current,
          req,
          url,
          target.path,
          srv,
        );
      } finally {
        slot.inFlight--;
        slot.lastActiveMs = Date.now();
      }
    },
    // Each socket keeps the handlers of the device endpoint that upgraded it.
    websocket: {
      maxPayloadLength: primary.ws.handlers.maxPayloadLength,
      open: (ws) => ws.data.handlers.open?.(ws),
      message: (ws, message) => ws.data.handlers.message(ws, message),
      close: (ws, code, reason) => ws.data.handlers.close?.(ws, code, reason),
    },
  };

  let server: ReturnType<typeof Bun.serve<WsData>>;
  try {
    server = serve<WsData>(serverOptions);
  } catch (err) {
    stopRequested = true;
    clearInterval(idleSweep);
    primary.deviceRecovery.stop();
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
    lifetime.abort();
    clearInterval(idleSweep);
    primary.deviceRecovery.stop();
    server.stop(true);
    const context = sessions.current;
    const error = new UploadManagerError("closed", "server is stopping", {
      serial: context.serial,
      generation: context.generation,
    });
    stopTask = Promise.all([
      emulators.shutdown(),
      sessions.close("server stopping"),
      ...[...pinned.keys()].map((serial) =>
        closePinned(serial, "server stopping"),
      ),
      ...closingSlots,
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

/** `req` with `path` as its pathname, keeping body, headers, and signal. */
function withPathname(req: Request, url: URL, path: string): Request {
  if (url.pathname === path) return req;
  const rewritten = new URL(url);
  rewritten.pathname = path;
  return new Request(rewritten, req);
}
