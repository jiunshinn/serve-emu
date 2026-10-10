import type { DeviceService } from "../device-service.ts";
import type { ApiErrorCode } from "./api-error.ts";
import type { AccessibilitySnapshot } from "../accessibility.ts";
import type { DeviceSessionManager } from "../device-session-context.ts";
import type { Gesture } from "../input.ts";
import type { JsonResponseTracker } from "../json-response.ts";
import type { GeoFix } from "../location.ts";
import type { DeviceContext, WsData } from "../server/types.ts";
import type { DeviceGridResponse } from "../shared/api-contracts.ts";

/** Session-bound services consumed by the production HTTP routes. */
export type ApiDependencies = {
  requestContext: DeviceContext;
  runForPublishedContext: <T>(
    context: DeviceContext,
    operation: (captured: DeviceContext) => Promise<T>,
  ) => Promise<T>;
  listDevices: (
    runExec?: typeof import("../exec.ts").execText,
  ) => Promise<import("../shared/api-contracts.ts").Device[]>;
  /** Bound to the request, so failures are logged with its method and path. */
  errorResponse: (err: unknown, fallback?: ApiErrorCode) => Response;
  deviceGrid: (context: DeviceContext) => Promise<DeviceGridResponse>;
  readJsonBody: (
    req: Request,
    maxBytes?: number,
    context?: DeviceContext,
    requireUsableContext?: boolean,
  ) => Promise<unknown>;
  MAX_JSON_BODY_BYTES: number;
  switchSession: (
    serial: string,
  ) => Promise<{
    ok: boolean;
    serial: string;
    generation: number;
    device: string;
  }>;
  launchEmulator: (
    opts: import("../emulator.ts").StartEmulatorOpts,
    dependencies?: import("../emulator.ts").EmulatorRuntimeDependencies,
  ) => Promise<import("../emulator.ts").EmulatorLaunch>;
  sessions: DeviceSessionManager<DeviceContext>;
  listActiveAvds: (
    devices?: readonly import("../shared/api-contracts.ts").Device[],
    dependencies?: Pick<
      import("../emulator.ts").EmulatorRuntimeDependencies,
      "execText" | "listAllDevices"
    >,
  ) => Promise<import("../emulator.ts").RunningAvd[]>;
  stopCurrentSession: (context: DeviceContext, reason: string) => Promise<void>;
  killEmulator: (
    serial: string,
    runExec?: typeof import("../exec.ts").execText,
  ) => Promise<void>;
  runForContext: <T>(
    context: DeviceContext,
    operation: (captured: DeviceContext, signal: AbortSignal) => Promise<T>,
    requestSignal?: AbortSignal,
  ) => Promise<T>;
  /** Device commands; pass the signal runForContext provides. */
  device: DeviceService;
  srv: Bun.Server<WsData>;
  logcatStream: (context: DeviceContext, req: Request, url: URL) => Response;
  readAccessibilitySnapshot: (
    context: DeviceContext,
    cacheMs?: number,
  ) => Promise<AccessibilitySnapshot>;
  accessibilityTapEndpoint: (
    context: DeviceContext,
    req: Request,
  ) => Promise<Response>;
  gestureEndpoint: (
    context: DeviceContext,
    req: Request,
    type: Gesture["type"],
    source: string,
  ) => Promise<Response>;
  keyEndpoint: (context: DeviceContext, req: Request) => Promise<Response>;
  responseMetrics: JsonResponseTracker<
    "health" | "sessionPage" | "sessionExport"
  >;
  enqueueGesture: (
    context: DeviceContext,
    gesture: Gesture,
    source: string,
    record?: boolean,
  ) => import("../control-input-queue.ts").ControlInputHandle;
  installEndpoint: (context: DeviceContext, req: Request) => Promise<Response>;
  fileImportEndpoint: (
    context: DeviceContext,
    req: Request,
  ) => Promise<Response>;
  appJsonEndpoint: (
    context: DeviceContext,
    req: Request,
    action: (
      payload: Record<string, unknown>,
      signal: AbortSignal,
    ) => unknown | Promise<unknown>,
  ) => Promise<Response>;
  applyLocation: (
    context: DeviceContext,
    fix: GeoFix,
    options: ApplyLocationOptions,
  ) => Promise<GeoFix & { appliedAt: string }>;
  MAX_ROUTE_BODY_BYTES: number;
};

export type ApplyLocationOptions = {
  /** Session-recording source, for example "rest:location". */
  source: string;
  /** Defaults to true; replay applies without recording. */
  record?: boolean;
  /** Defaults to the device session's signal. */
  signal?: AbortSignal;
  /** Throws when the caller may no longer apply; defaults to the session check. */
  ensureCurrent?: () => void;
};
