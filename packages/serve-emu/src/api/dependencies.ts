import type { DeviceService } from "../device-service.ts";
import type { ApiErrorFallback } from "./error-mapping.ts";
import type { AccessibilitySnapshot } from "../accessibility.ts";
import type { ControlInputHandle } from "../control-input-queue.ts";
import type { DeviceSessionManager } from "../device-session-context.ts";
import type {
  EmulatorLaunch,
  RunningAvd,
  StartEmulatorOpts,
} from "../emulator.ts";
import type { Gesture } from "../input.ts";
import type { JsonResponseTracker } from "../json-response.ts";
import type { GeoFix } from "../location.ts";
import type { DeviceContext, WsData } from "../server/types.ts";
import type { UploadEndpoints } from "../server/uploads.ts";
import type {
  Device,
  DeviceGridResponse,
  DeviceSelectionResponse,
} from "../shared/api-contracts.ts";

/** Session-bound services consumed by the production HTTP routes. */
export type ApiDependencies = {
  requestContext: DeviceContext;
  sessions: DeviceSessionManager<DeviceContext>;
  srv: Bun.Server<WsData>;
  /** Bound to the request, so failures are logged with its method and path. */
  errorResponse: (err: unknown, fallback?: ApiErrorFallback) => Response;
  readJsonBody: (
    req: Request,
    maxBytes?: number,
    context?: DeviceContext,
    requireUsableContext?: boolean,
  ) => Promise<unknown>;
  MAX_JSON_BODY_BYTES: number;
  MAX_ROUTE_BODY_BYTES: number;
  runForPublishedContext: <T>(
    context: DeviceContext,
    operation: (captured: DeviceContext) => Promise<T>,
  ) => Promise<T>;
  runForContext: <T>(
    context: DeviceContext,
    operation: (captured: DeviceContext, signal: AbortSignal) => Promise<T>,
    requestSignal?: AbortSignal,
  ) => Promise<T>;
  /** Device commands; pass the signal runForContext provides. */
  device: DeviceService;
  listDevices: () => Promise<Device[]>;
  deviceGrid: (context: DeviceContext) => Promise<DeviceGridResponse>;
  switchSession: (serial: string) => Promise<DeviceSelectionResponse>;
  launchEmulator: (opts: StartEmulatorOpts) => Promise<EmulatorLaunch>;
  listActiveAvds: () => Promise<RunningAvd[]>;
  killEmulator: (serial: string) => Promise<void>;
  readAccessibilitySnapshot: (
    context: DeviceContext,
    cacheMs?: number,
  ) => Promise<AccessibilitySnapshot>;
  enqueueGesture: (
    context: DeviceContext,
    gesture: Gesture,
    source: string,
    record?: boolean,
  ) => ControlInputHandle;
  applyLocation: (
    context: DeviceContext,
    fix: GeoFix,
    options: ApplyLocationOptions,
  ) => Promise<GeoFix & { appliedAt: string }>;
  uploads: UploadEndpoints;
  responseMetrics: JsonResponseTracker<
    "health" | "sessionPage" | "sessionExport"
  >;
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
