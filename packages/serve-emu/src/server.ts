import type { ServerWebSocket } from "bun";
import { timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertValidToken } from "./access-policy.ts";
import {
  findAccessibilityNode,
  getAccessibilitySnapshot,
  parseAccessibilitySelector,
  type AccessibilitySnapshot,
} from "./accessibility.ts";
import { listAllDevices } from "./adb.ts";
import { loadDeviceGrid } from "./device-grid.ts";
import { createApiRouter } from "./api/router.ts";
import type { ApplyLocationOptions } from "./api/dependencies.ts";
import { createDeviceService, type DeviceService } from "./device-service.ts";
import { ApiError, apiErrorResponse } from "./api/api-error.ts";
import { toApiError, type ApiErrorFallback } from "./api/error-mapping.ts";
import { createApiRoutes } from "./api/routes/index.ts";
import { importMediaFile, installApk } from "./app-management.ts";
import { logApiFailure } from "./command-failure.ts";
import { ControlInputError, ControlInputQueue } from "./control-input-queue.ts";
import {
  ActiveDeviceSession,
  DeviceSessionManager,
  SessionChangedError,
} from "./device-session-context.ts";
import {
  listAvds,
  listRunningAvds,
  startEmulator,
  stopEmulator,
  type EmulatorLaunch,
} from "./emulator.ts";
import { getExecSnapshot } from "./exec.ts";
import { parseGesture, resetVideoPacket, type Gesture } from "./input.ts";
import { JsonResponseTracker } from "./json-response.ts";
import { setEmulatorLocationAsync, type GeoFix } from "./location.ts";
import {
  MultipartUploadError,
  stageMultipartUpload,
} from "./multipart-upload.ts";
import { HttpBodyError, readJsonLimited } from "./request-body.ts";
import { shouldRecordPayload } from "./session-api.ts";
import {
  closeScrcpySession,
  ScrcpyStreamError,
  startScrcpy,
  type ScrcpySession,
} from "./scrcpy.ts";
import { buildHealthSnapshot } from "./server/health.ts";
import { serveStaticFile } from "./server/static.ts";
import type { Client, DeviceContext, WsData } from "./server/types.ts";
import {
  frameDeliveryDecision,
  sendResultDecision,
} from "./server/backpressure.ts";
import {
  createHostAllowlist,
  fetchMetadataAllowed,
  normalizeHostname,
} from "./server/request-policy.ts";
import {
  SessionRecoveryWatchdog,
  SYSTEM_RECOVERY_WATCHDOG_CLOCK,
  type RecoveryWatchdogClock,
} from "./session-recovery-watchdog.ts";
import {
  isAbnormalExit,
  procExitDetail,
  terminalTransitionAllowed,
  type SessionStatus,
} from "./session-status.ts";
import type { DeviceSelectionResponse } from "./shared/api-contracts.ts";
import {
  epochNowMs,
  FRAME_META_HEADER_BYTES,
  writeFrameMetaHeader,
} from "./shared/frame-meta.ts";
import type { DeviceGridResponse } from "./shared/api-contracts.ts";
import {
  parseWsClientMessage,
  parseWsRequestId,
} from "./shared/websocket-contracts.ts";
import {
  MAX_UPLOAD_QUEUE_TIMEOUT_MS,
  UploadManager,
  UploadManagerError,
  type UploadContext,
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
export const DEFAULT_MAX_APK_UPLOAD_BYTES = 512 * 1024 * 1024;
export const DEFAULT_MAX_MEDIA_UPLOAD_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_MAX_ACTIVE_UPLOADS = 2;
export const DEFAULT_MAX_QUEUED_UPLOADS = 4;
export const DEFAULT_UPLOAD_QUEUE_TIMEOUT_MS = 5_000;
const MULTIPART_BODY_OVERHEAD_BYTES = 1024 * 1024;
const SESSION_COOKIE = "semu_session";

/** Constant-time string compare that never throws on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    out[key] = part.slice(idx + 1).trim();
  }
  return out;
}


const MAX_WS_MESSAGE_BYTES = 16 * 1024;
const DROP_FRAME_BUFFERED_BYTES = 512 * 1024;
const CLOSE_CLIENT_BUFFERED_BYTES = 16 * 1024 * 1024;
const VIDEO_RESET_COOLDOWN_MS = 500;
const FIRST_FRAME_RESET_MS = 5000;
const SOURCE_STALL_RESET_MS = 2500;
const AWAITING_KEYFRAME_RESET_MS = 2500;
const RESET_SETTLE_MS = 2500;
const MAX_RESET_SETTLE_MS = 30_000;
const MAX_JSON_BODY_BYTES = 8 * 1024;
const MAX_ROUTE_BODY_BYTES = 2 * 1024 * 1024;
const MAX_LOGCAT_QUERY_BYTES = 200;

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
  const startEmulatorProcess = dependencies.startEmulator ?? startEmulator;
  const stopEmulatorBySerial = dependencies.stopEmulator ?? stopEmulator;
  // Emulators started through /api/avds/start belong to this server, like the
  // CLI's --avd launch belongs to the CLI: they stop when it stops.
  const launchedEmulators = new Map<string, EmulatorLaunch>();
  // Launches still booting; on stop they abort and stop their own child, and
  // stop() waits for that so the process cannot exit first.
  const bootingEmulators = new Set<Promise<unknown>>();
  const emulatorShutdown = new AbortController();
  const launchEmulator: typeof startEmulator = async (opts, runtime) => {
    const signal = opts.signal
      ? AbortSignal.any([opts.signal, emulatorShutdown.signal])
      : emulatorShutdown.signal;
    const booting = startEmulatorProcess({ ...opts, signal }, runtime);
    bootingEmulators.add(booting);
    let launch: EmulatorLaunch;
    try {
      launch = await booting;
    } finally {
      bootingEmulators.delete(booting);
    }
    if (!launch.ownsProcess) return launch;
    const owned: EmulatorLaunch = {
      ...launch,
      stop: async () => {
        if (launchedEmulators.get(launch.serial) === owned) {
          launchedEmulators.delete(launch.serial);
        }
        await launch.stop();
      },
    };
    launchedEmulators.set(launch.serial, owned);
    // Once it exits on its own, its port may go to another AVD, which
    // /api/avds/stop and stop() must not treat as this launch.
    launch.proc?.once("exit", () => {
      if (launchedEmulators.get(launch.serial) === owned) {
        launchedEmulators.delete(launch.serial);
      }
    });
    return owned;
  };
  const killEmulator: typeof stopEmulator = async (serial, runExec) => {
    const owned = launchedEmulators.get(serial);
    if (owned) return owned.stop();
    return stopEmulatorBySerial(serial, runExec);
  };
  const listActiveAvds = dependencies.listRunningAvds ?? listRunningAvds;
  const availableAvds = dependencies.listAvds ?? listAvds;
  const loadAccessibility =
    dependencies.loadAccessibility ??
    ((serial: string, signal: AbortSignal) =>
      getAccessibilitySnapshot(serial, signal));
  const setLocation =
    dependencies.setLocation ??
    ((serial: string, fix: GeoFix, signal: AbortSignal) =>
      setEmulatorLocationAsync(serial, fix, signal));
  const device = dependencies.deviceService ?? createDeviceService();
  const createInputQueue =
    dependencies.createInputQueue ??
    ((session: ScrcpySession) =>
      new ControlInputQueue({ socket: session.controlSocket }));
  const recoveryClock =
    dependencies.recoveryClock ?? SYSTEM_RECOVERY_WATCHDOG_CLOCK;
  const stageUpload = dependencies.stageMultipartUpload ?? stageMultipartUpload;
  const installStagedApk = dependencies.installApk ?? installApk;
  const importStagedMedia = dependencies.importMediaFile ?? importMediaFile;
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
  const uploads = (
    dependencies.createUploadManager ??
    ((options: UploadManagerOptions) => new UploadManager(options))
  )({
    maxActive: maxActiveUploads,
    maxQueued: maxQueuedUploads,
    queueTimeoutMs: uploadQueueTimeoutMs,
  });

  const uiDir = dependencies.uiDir ?? UI_DIR;
  const host = opts.host ?? DEFAULT_HOST;
  const authToken = opts.token && opts.token.length > 0 ? opts.token : null;
  for (const name of opts.allowedHosts ?? []) {
    if (!normalizeHostname(name)) {
      throw new Error(`invalid allowed host ${JSON.stringify(name)}`);
    }
  }
  const hostAllowed = createHostAllowlist([host, ...(opts.allowedHosts ?? [])]);
  let warnedForbiddenHost = false;

  /** Token presented by the request, from bearer header, cookie, or query. */
  const presentedToken = (req: Request, url: URL): string | null => {
    const authorization = req.headers.get("authorization");
    if (authorization && authorization.startsWith("Bearer ")) {
      return authorization.slice("Bearer ".length).trim();
    }
    const cookie = parseCookies(req.headers.get("cookie"))[SESSION_COOKIE];
    if (cookie) return cookie;
    return url.searchParams.get("token");
  };

  const tokenValid = (req: Request, url: URL): boolean => {
    if (!authToken) return true;
    const presented = presentedToken(req, url);
    return presented !== null && safeEqual(presented, authToken);
  };

  /**
   * Same-origin guard for state-changing requests and the WebSocket upgrade.
   * A missing Origin means a non-browser client (CLI/agent), which is gated by
   * the token check instead. A present Origin must match the request Host.
   */
  const originAllowed = (req: Request): boolean => {
    const origin = req.headers.get("origin");
    if (!origin) return true;
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return false;
    }
    return originHost === req.headers.get("host");
  };

  const forbiddenResponse = (message: string): Response =>
    apiErrorResponse(new ApiError(403, "forbidden", message));

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
  const recoveries = new WeakMap<
    DeviceContext,
    SessionRecoveryWatchdog<Client>
  >();
  const responseMetrics = new JsonResponseTracker([
    "health",
    "sessionPage",
    "sessionExport",
  ] as const);
  let stopRequested = false;
  log(
    `scrcpy ready: ${initialScrcpy.meta.deviceName} • ${initialScrcpy.meta.codecId} • ${initialScrcpy.meta.width}×${initialScrcpy.meta.height}`,
  );

  const health = (context = sessions.current) => {
    const now = recoveryClock.now();
    return buildHealthSnapshot(context, {
      nowMs: now,
      recovery: recoveries.get(context)?.snapshot(now) ?? null,
      idleResetBackoffMs: RESET_SETTLE_MS,
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

  const markTerminal = (
    context: DeviceContext,
    nextStatus: Exclude<SessionStatus, "streaming">,
    reason: string,
    detail?: { code?: string; meta?: Record<string, string | number> | null },
  ) => {
    if (sessions.current !== context) return;
    if (!terminalTransitionAllowed(context.status, nextStatus)) return;
    context.terminalTransitionStarted = true;
    context.status = nextStatus;
    context.lastError = reason;
    context.lastErrorCode = detail?.code ?? null;
    context.lastErrorMeta = detail?.meta ?? null;
    void context.dispose(reason, {
      status: nextStatus,
      clientCode: nextStatus === "error" ? 1011 : 1000,
    });
  };

  const sendJson = (ws: ServerWebSocket<WsData>, value: unknown) => {
    try {
      ws.send(JSON.stringify(value));
    } catch {}
  };

  const withFrameMeta = (
    frameData: Buffer,
    frame: { pts: bigint; isKey: boolean },
    config: Buffer | null,
  ): Buffer => {
    const configBytes = config?.length ?? 0;
    const out = Buffer.allocUnsafe(
      FRAME_META_HEADER_BYTES + configBytes + frameData.length,
    );
    writeFrameMetaHeader(out, {
      isKey: frame.isKey,
      pts: frame.pts,
      serverTsMs: epochNowMs(),
    });
    if (config) config.copy(out, FRAME_META_HEADER_BYTES);
    frameData.copy(out, FRAME_META_HEADER_BYTES + configBytes);
    return out;
  };

  const withConfig = (frameData: Buffer, config: Buffer | null): Buffer => {
    if (!config) return frameData;
    const out = Buffer.allocUnsafe(config.length + frameData.length);
    config.copy(out, 0);
    frameData.copy(out, config.length);
    return out;
  };

  const wantsAck = (value: unknown) => {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return true;
    return (value as Record<string, unknown>).ack !== false;
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

  // WebSocket replies keep their own contract (see websocket-contracts.ts).
  const inputErrorPayload = (err: unknown, status: "rejected" | "failed") => ({
    ok: false as const,
    status,
    ...(err instanceof ControlInputError ? { code: err.code } : {}),
    error: err instanceof Error ? err.message : String(err),
  });

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

  const shouldRecord = shouldRecordPayload;

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

  let nextTouchId = 1;

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

  const enqueueClientGesture = (
    ws: ServerWebSocket<WsData>,
    gesture: Gesture,
    recordRequested: boolean,
  ) => {
    const client = ws.data.handle;
    if (gesture.type !== "touch")
      return enqueueGesture(ws.data.context, gesture, "ws", recordRequested);
    if (!client) throw new Error("WebSocket client is not open");
    const sourceId = gesture.pointerId ?? 0;
    const previous = client.touches.get(sourceId);
    if (gesture.action === "down" ? previous : !previous) {
      throw new Error(
        gesture.action === "down"
          ? "pointer is already down"
          : "pointer is not down",
      );
    }
    if (!previous && !Number.isSafeInteger(nextTouchId))
      throw new Error("pointer id space exhausted");
    const mapped = {
      ...gesture,
      pointerId: previous?.gesture.pointerId ?? nextTouchId++,
    };
    // Recording is decided once per pointer, at its down: the pointer's moves,
    // its up, and a disconnect release all follow that decision, so a session
    // never holds a down without its up (or an up without its down).
    const record = previous ? previous.record : recordRequested;
    const accepted = enqueueGesture(ws.data.context, mapped, "ws", record);
    if (gesture.action === "up") client.touches.delete(sourceId);
    else client.touches.set(sourceId, { gesture: mapped, record });
    return accepted;
  };

  const releaseClientTouches = (client: Client) => {
    // The input queue reserves an UP slot for every admitted DOWN, even when full.
    // Never redirect a late disconnect's releases onto a replacement session.
    if (sessions.isCurrent(client.context)) {
      for (const { gesture, record } of client.touches.values()) {
        try {
          const accepted = enqueueGesture(
            client.context,
            { ...gesture, action: "up" },
            "ws:disconnect",
            record,
          );
          void accepted.completion.catch(() => {});
        } catch {}
      }
    }
    client.touches.clear();
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

  const logcatStream = (context: DeviceContext, req: Request, url: URL) => {
    const packageName = (url.searchParams.get("package") ?? "")
      .trim()
      .slice(0, MAX_LOGCAT_QUERY_BYTES);
    const search = (url.searchParams.get("search") ?? "")
      .trim()
      .slice(0, MAX_LOGCAT_QUERY_BYTES)
      .toLowerCase();
    return context.logcat.subscribe({ packageName, search }, req.signal);
  };

  const gestureEndpoint = async (
    context: DeviceContext,
    req: Request,
    type: Gesture["type"],
    source: string,
  ) => {
    try {
      const payload = await readJsonBody(req, MAX_JSON_BODY_BYTES, context);
      const gesture = parseGesture(
        typeof payload === "object" &&
          payload !== null &&
          !Array.isArray(payload)
          ? { ...payload, type }
          : payload,
      );
      const accepted = enqueueGesture(
        context,
        gesture,
        source,
        shouldRecord(payload),
      );
      try {
        const result = await accepted.completion;
        return Response.json({ ok: true, status: result.status });
      } catch (err) {
        return errorResponse(err, req);
      }
    } catch (err) {
      return errorResponse(err, req);
    }
  };

  const keyEndpoint = async (context: DeviceContext, req: Request) => {
    try {
      const payload = await readJsonBody(req, MAX_JSON_BODY_BYTES, context);
      if (
        typeof payload !== "object" ||
        payload === null ||
        Array.isArray(payload)
      ) {
        throw new Error("key payload must be an object");
      }
      const key = (payload as Record<string, unknown>).key;
      const gesture =
        key === "back" || key === "home" || key === "recents" || key === "power"
          ? parseGesture({ type: key })
          : parseGesture({ ...payload, type: "key" });
      const accepted = enqueueGesture(
        context,
        gesture,
        "rest:key",
        shouldRecord(payload),
      );
      try {
        const result = await accepted.completion;
        return Response.json({ ok: true, status: result.status });
      } catch (err) {
        return errorResponse(err, req);
      }
    } catch (err) {
      return errorResponse(err, req);
    }
  };

  const accessibilityTapEndpoint = async (
    context: DeviceContext,
    req: Request,
  ) => {
    try {
      const payload = await readJsonBody(req, MAX_JSON_BODY_BYTES, context);
      if (
        typeof payload !== "object" ||
        payload === null ||
        Array.isArray(payload)
      ) {
        throw new Error("accessibility tap payload must be an object");
      }
      const body = payload as Record<string, unknown>;
      const selector = parseAccessibilitySelector(body.selector ?? body);
      const snapshot = await readAccessibilitySnapshot(context, 1_000);
      const node = findAccessibilityNode(snapshot.nodes, selector);
      const centerX = (node.bounds.left + node.bounds.right) / 2;
      const centerY = (node.bounds.top + node.bounds.bottom) / 2;
      const accessibilityWidth = Math.max(
        ...snapshot.nodes.map((n) => n.bounds.right),
        context.screen.width,
      );
      const accessibilityHeight = Math.max(
        ...snapshot.nodes.map((n) => n.bounds.bottom),
        context.screen.height,
      );
      const x = centerX / accessibilityWidth;
      const y = centerY / accessibilityHeight;
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        x < 0 ||
        x > 1 ||
        y < 0 ||
        y > 1
      ) {
        throw new Error(
          "matched accessibility node is outside the current stream bounds",
        );
      }
      const accepted = enqueueGesture(
        context,
        {
          type: "tap",
          x,
          y,
        },
        "accessibility:tap",
        shouldRecord(payload),
      );
      try {
        const result = await accepted.completion;
        return Response.json({
          ok: true,
          status: result.status,
          node,
          capturedAt: snapshot.capturedAt,
        });
      } catch (err) {
        return errorResponse(err, req);
      }
    } catch (err) {
      return errorResponse(err, req);
    }
  };

  const appJsonEndpoint = async (
    context: DeviceContext,
    req: Request,
    action: (
      payload: Record<string, unknown>,
      signal: AbortSignal,
    ) => unknown | Promise<unknown>,
  ) => {
    try {
      const payload = await readJsonBody(req, MAX_JSON_BODY_BYTES, context);
      if (
        typeof payload !== "object" ||
        payload === null ||
        Array.isArray(payload)
      ) {
        throw new Error("payload must be an object");
      }
      const result = await runForContext(
        context,
        (_captured, signal) =>
          Promise.resolve(action(payload as Record<string, unknown>, signal)),
        req.signal,
      );
      return Response.json(result);
    } catch (err) {
      return errorResponse(err, req);
    }
  };

  const uploadEndpoint = async (
    context: DeviceContext,
    req: Request,
    options: {
      fieldName: "apk" | "file";
      maxFileBytes: number;
      action: (
        serial: string,
        file: Awaited<ReturnType<typeof stageUpload>>,
        signal: AbortSignal,
      ) => Promise<unknown>;
    },
  ) => {
    try {
      const uploadContext: UploadContext = {
        serial: context.serial,
        generation: context.generation,
      };
      const result = await uploads.run(
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
      return Response.json(result);
    } catch (error) {
      if (req.body && !req.body.locked) {
        await req.body.cancel(error).catch(() => {});
      }
      return errorResponse(error, req);
    }
  };

  const installEndpoint = (context: DeviceContext, req: Request) =>
    uploadEndpoint(context, req, {
      fieldName: "apk",
      maxFileBytes: maxApkUploadBytes,
      action: (serial, file, signal) => installStagedApk(serial, file, signal),
    });

  const fileImportEndpoint = (context: DeviceContext, req: Request) =>
    uploadEndpoint(context, req, {
      fieldName: "file",
      maxFileBytes: maxMediaUploadBytes,
      action: (serial, file, signal) => importStagedMedia(serial, file, signal),
    });

  const enqueueVideoReset = (context: DeviceContext, reason: string) => {
    sessions.assertCurrent(context);
    context.inputQueue.assertOpen();
    const now = recoveryClock.now();
    // Client requests share the watchdog's gate, so they cannot restart an
    // encoder whose key frame is still on its way.
    const recovery = recoveries.get(context);
    const blocked = recovery
      ? !recovery.canRequestReset(now)
      : now - context.lastVideoResetMs < VIDEO_RESET_COOLDOWN_MS;
    if (blocked) {
      return { completion: Promise.resolve({ status: "coalesced" as const }) };
    }
    // Priority: a reset must not wait behind a long swipe (the next step
    // boundary is at most ~20 ms away), and it is excluded from the depth
    // limit so a full gesture queue cannot block it.
    const accepted = context.inputQueue.enqueuePacket(resetVideoPacket(), {
      coalesceKey: "reset-video",
      priority: true,
    });
    recovery?.noteResetAdmitted(now);
    context.lastVideoResetMs = now;
    context.videoResetRequests++;
    context.lastVideoResetAt = new Date(now).toISOString();
    context.lastVideoResetReason = reason;
    return accepted;
  };

  const createRecovery = (context: DeviceContext) =>
    new SessionRecoveryWatchdog<Client>({
      clock: recoveryClock,
      clients: () => context.clients,
      startedMs: recoveryClock.now(),
      intervalMs: 1_000,
      sessionResetCooldownMs: VIDEO_RESET_COOLDOWN_MS,
      firstFrameResetMs: FIRST_FRAME_RESET_MS,
      sourceStallResetMs: SOURCE_STALL_RESET_MS,
      awaitingKeyFrameResetMs: AWAITING_KEYFRAME_RESET_MS,
      resetSettleMs: RESET_SETTLE_MS,
      maxResetSettleMs: MAX_RESET_SETTLE_MS,
      requestReset: (reason, now) => {
        if (!sessions.isCurrent(context) || context.status !== "streaming") {
          return false;
        }
        try {
          const accepted = context.inputQueue.enqueuePacket(
            resetVideoPacket(),
            { coalesceKey: "reset-video", priority: true },
          );
          void accepted.completion.catch(() => {});
          context.lastVideoResetMs = now;
          context.videoResetRequests++;
          context.lastVideoResetAt = new Date(now).toISOString();
          context.lastVideoResetReason = reason;
          return true;
        } catch {
          return false;
        }
      },
    });

  const dropUntilKeyFrame = (client: Client) => {
    client.droppedFrames++;
    client.context.totalDroppedFrames++;
    const recovery = recoveries.get(client.context);
    recovery?.markAwaiting(client);
    recovery?.requestVideoReset("client backpressure");
  };

  const sendFrame = (
    client: Client,
    data: () => Buffer,
    isKeyFrame: boolean,
  ) => {
    const decision = frameDeliveryDecision({
      awaitingKeyFrame: client.awaitingKeyFrame,
      isKeyFrame,
      bufferedBytes: client.ws.getBufferedAmount(),
      dropThresholdBytes: DROP_FRAME_BUFFERED_BYTES,
      closeThresholdBytes: CLOSE_CLIENT_BUFFERED_BYTES,
    });
    if (decision === "drop-awaiting-keyframe") {
      client.droppedFrames++;
      client.context.totalDroppedFrames++;
      return;
    }
    if (decision === "close-slow-client") {
      client.context.clients.delete(client);
      try {
        client.ws.close(1013, "client too slow");
      } catch {}
      return;
    }
    if (decision === "drop-buffered") {
      dropUntilKeyFrame(client);
      return;
    }
    let sent: number;
    try {
      sent = client.ws.send(data());
    } catch {
      client.context.clients.delete(client);
      try {
        client.ws.close(1011, "frame send failed");
      } catch {}
      return;
    }
    if (sendResultDecision(sent) === "backpressure") {
      client.backpressureEvents++;
      client.context.totalBackpressureEvents++;
      dropUntilKeyFrame(client);
      return;
    }
    if (sendResultDecision(sent) === "closed") {
      client.context.clients.delete(client);
      return;
    }
    client.sentFrames++;
    if (isKeyFrame) recoveries.get(client.context)?.keyFrameAccepted(client);
  };
  const startFramePump = (context: DeviceContext) => {
    context.cachedConfig = null;
    const pump = (async () => {
      try {
        while (!stopRequested && sessions.isCurrent(context)) {
          const f = await context.scrcpy.readFrame();
          if (!sessions.isCurrent(context)) break;
          if (!f) {
            if (!stopRequested)
              markTerminal(context, "stopped", "scrcpy video stream ended");
            break;
          }
          if (f.type === "session") {
            if (f.width > 0 && f.height > 0) {
              context.screen.width = f.width;
              context.screen.height = f.height;
              context.cachedConfig = null;
              // A new encoder session always opens with codec config and a
              // key frame. Requesting a reset here would restart the encoder
              // before it can send that key frame.
              for (const c of context.clients) {
                recoveries.get(context)?.markAwaiting(c);
                sendJson(c.ws, {
                  type: "video-session",
                  size: { width: f.width, height: f.height },
                });
              }
            }
            continue;
          }
          if (f.isConfig) {
            context.cachedConfig = f.data;
            context.configPacketCount++;
            continue;
          }
          context.frameCount++;
          recoveries.get(context)?.recordFrame(f.isKey);
          context.frameStats.record(f.data.length, f.isKey);
          const config = f.isKey ? context.cachedConfig : null;
          let rawOut: Buffer | null = null;
          let framedOut: Buffer | null = null;
          for (const c of context.clients) {
            sendFrame(
              c,
              () =>
                c.frameMeta
                  ? (framedOut ??= withFrameMeta(f.data, f, config))
                  : (rawOut ??= withConfig(f.data, config)),
              f.isKey,
            );
          }
        }
      } catch (err) {
        if (
          stopRequested ||
          (context.signal.aborted && !context.terminalTransitionStarted)
        ) {
          return;
        }
        if (err instanceof ScrcpyStreamError) {
          markTerminal(context, "error", err.message, {
            code: err.code,
            meta: err.meta ?? null,
          });
        } else {
          markTerminal(context, "error", String(err));
        }
      }
    })();
    void context.trackDrain(pump).catch(() => {});
  };

  const attachSessionHandlers = (context: DeviceContext) => {
    context.scrcpy.proc.once("exit", (code, signal) => {
      // An abnormal exit (non-zero code or killed by signal) means scrcpy died
      // unexpectedly — classify it as "error" even if the video socket already
      // ended cleanly and marked the session "stopped" (markTerminal escalates).
      // Normal exits and server-initiated teardowns (stopRequested / a bumped
      // generation) are left alone.
      if (
        stopRequested ||
        sessions.current !== context ||
        (context.signal.aborted && !context.terminalTransitionStarted)
      ) {
        return;
      }
      if (!isAbnormalExit(code, signal)) return;
      const { reason, ...detail } = procExitDetail(code, signal);
      markTerminal(context, "error", reason, detail);
    });
    context.scrcpy.controlSocket.once("error", (err) => {
      if (
        !stopRequested &&
        sessions.current === context &&
        (!context.signal.aborted || context.terminalTransitionStarted)
      ) {
        markTerminal(
          context,
          "error",
          `scrcpy control socket error: ${err.message}`,
        );
      }
    });
  };

  const activateContext = (context: DeviceContext) => {
    const recovery = createRecovery(context);
    recoveries.set(context, recovery);
    context.registerCleanup(() => recovery.stop());
    startFramePump(context);
    attachSessionHandlers(context);
    recovery.start();
  };

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
      activateContext,
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

  const stopCurrentSession = (context: DeviceContext, reason: string) =>
    sessions.stop(context, reason);

  try {
    activateContext(sessions.current);
  } catch (err) {
    stopRequested = true;
    await sessions.close("server startup failed");
    throw err;
  }

  const apiRouter = createApiRouter(createApiRoutes());
  const apiServices = {
    runForPublishedContext,
    listDevices,
    deviceGrid,
    readJsonBody,
    MAX_JSON_BODY_BYTES,
    switchSession,
    launchEmulator,
    sessions,
    listActiveAvds,
    stopCurrentSession,
    killEmulator,
    runForContext,
    logcatStream,
    readAccessibilitySnapshot,
    accessibilityTapEndpoint,
    gestureEndpoint,
    keyEndpoint,
    responseMetrics,
    enqueueGesture,
    device,
    installEndpoint,
    fileImportEndpoint,
    appJsonEndpoint,
    applyLocation,
    MAX_ROUTE_BODY_BYTES,
  };

  let nextId = 1;
  const serverOptions: Parameters<typeof Bun.serve<WsData>>[0] = {
    port: opts.port,
    hostname: host,
    maxRequestBodySize,
    async fetch(req, srv) {
      const requestContext = sessions.current;
      const url = new URL(req.url);

      // DNS-rebinding guard: without a token, a page whose own host name was
      // rebound to this address would pass the same-origin check below, so
      // only host names that cannot be rebound are served. With a token, the
      // secret and the host-scoped cookie already keep such pages out.
      if (!authToken) {
        const hostHeader = req.headers.get("host");
        if (!hostAllowed(hostHeader)) {
          if (!warnedForbiddenHost) {
            warnedForbiddenHost = true;
            console.warn(
              `Rejected a request for host ${JSON.stringify(hostHeader?.slice(0, 100))}. ` +
                "Without --token only IP addresses, localhost, and --allowed-host names are served.",
            );
          }
          return forbiddenResponse("forbidden host");
        }
      }
      if (!fetchMetadataAllowed(req)) {
        return forbiddenResponse("forbidden cross-site request");
      }

      // Bootstrap: exchange a valid one-time URL token for an HttpOnly cookie,
      // then redirect to a clean URL so the secret never lingers in the address
      // bar, browser history, or referer logs. Same-origin fetch/EventSource/WS
      // calls carry the cookie automatically afterward. Scoped to browser
      // navigations (Accept: text/html) so agents hitting `/api?token=` still
      // get their JSON response instead of a redirect.
      if (
        authToken &&
        req.method === "GET" &&
        (req.headers.get("accept") ?? "").includes("text/html")
      ) {
        const queryToken = url.searchParams.get("token");
        if (queryToken && safeEqual(queryToken, authToken)) {
          const clean = new URL(url);
          clean.searchParams.delete("token");
          return new Response(null, {
            status: 303,
            headers: {
              Location: `${clean.pathname}${clean.search}`,
              "Set-Cookie": `${SESSION_COOKIE}=${authToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
            },
          });
        }
      }

      if (!tokenValid(req, url)) {
        return apiErrorResponse(
          new ApiError(401, "unauthorized", "unauthorized", {
            headers: { "WWW-Authenticate": "Bearer" },
          }),
        );
      }

      // CSRF / cross-origin guard: reject upgrades and state-changing requests
      // whose Origin does not match the host. Applied even without auth so the
      // control channel is never open to arbitrary cross-origin pages.
      if (
        url.pathname === "/ws" ||
        (req.method !== "GET" && req.method !== "HEAD")
      ) {
        if (!originAllowed(req)) return forbiddenResponse("forbidden origin");
      }

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
        if (requestContext.status !== "streaming") {
          return new Response(JSON.stringify(health(requestContext)), {
            status: 503,
            headers: { "Content-Type": "application/json; charset=utf-8" },
          });
        }
        const frameMeta = url.searchParams.get("frame-meta") === "1";
        const ok = srv.upgrade(req, {
          data: { id: nextId++, frameMeta, context: requestContext },
        });
        if (ok) return undefined as unknown as Response;
        return new Response("upgrade failed", { status: 400 });
      }

      return serveStaticFile(uiDir, url.pathname);
    },
    websocket: {
      maxPayloadLength: MAX_WS_MESSAGE_BYTES,
      open(ws) {
        const context = ws.data.context;
        if (!sessions.isCurrent(context)) {
          sendJson(ws, {
            ok: false,
            code: "session_changed",
            error: "device session changed",
          });
          ws.close(1012, "device session changed");
          return;
        }
        const handle: Client = {
          touches: new Map(),
          id: ws.data.id,
          ws,
          context,
          frameMeta: ws.data.frameMeta,
          sentFrames: 0,
          droppedFrames: 0,
          backpressureEvents: 0,
          awaitingKeyFrame: false,
          awaitingKeyFrameSinceMs: null,
          lastKeyFrameRequestMs: null,
        };
        context.clients.add(handle);
        ws.data.handle = handle;
        const recovery = recoveries.get(context);
        recovery?.markAwaiting(handle);
        recovery?.requestVideoReset("client opened");
      },
      message(ws, raw) {
        const context = ws.data.context;
        if (!sessions.isCurrent(context)) {
          ws.close(1012, "device session changed");
          return;
        }
        if (typeof raw !== "string") return;
        if (raw.length > MAX_WS_MESSAGE_BYTES) {
          ws.close(1009, "message too large");
          return;
        }
        let acknowledge = true;
        let requestId: string | undefined;
        const reply = (value: Record<string, unknown>) =>
          sendJson(ws, {
            ...value,
            ...(requestId === undefined ? {} : { requestId }),
          });
        try {
          const payload = JSON.parse(raw);
          acknowledge = wantsAck(payload);
          requestId = parseWsRequestId(payload?.requestId);
          // Checked after the request id is known so the error reply carries it.
          if (context.status !== "streaming") {
            throw new Error(`session is ${context.status}`);
          }
          const msg = parseWsClientMessage(payload);
          if (msg.type === "clock-sync") {
            reply({ type: "clock-sync", clientTsMs: msg.clientTsMs, serverTsMs: epochNowMs() });
            return;
          }
          if (msg.type === "reset-video") {
            const accepted = enqueueVideoReset(
              context,
              "client requested keyframe",
            );
            void accepted.completion
              .then((result) => {
                if (acknowledge) {
                  reply({ ok: true, status: result.status });
                }
              })
              .catch((err) => {
                if (acknowledge) {
                  reply(inputErrorPayload(err, "failed"));
                }
              });
            return;
          }
          const accepted = enqueueClientGesture(ws, msg, shouldRecord(payload));
          void accepted.completion
            .then((result) => {
              if (acknowledge) {
                reply({ ok: true, status: result.status });
              }
            })
            .catch((err) => {
              if (acknowledge) {
                reply(inputErrorPayload(err, "failed"));
              }
            });
        } catch (err) {
          if (acknowledge) {
            reply(inputErrorPayload(err, "rejected"));
          }
        }
      },
      close(ws) {
        if (ws.data.handle) {
          releaseClientTouches(ws.data.handle);
          ws.data.context.clients.delete(ws.data.handle);
        }
      },
    },
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
    emulatorShutdown.abort(new Error("server is stopping"));
    const owned = Array.from(launchedEmulators.values());
    launchedEmulators.clear();
    const booting = Array.from(bootingEmulators, (launch) =>
      launch.catch(() => {}),
    );
    stopTask = Promise.all([
      ...booting,
      sessions.close("server stopping"),
      uploads.close(error),
      ...owned.map((launch) =>
        Promise.resolve()
          .then(() => launch.stop())
          .catch((err) => {
            console.error(`[emulator] could not stop ${launch.serial}:`, err);
          }),
      ),
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
