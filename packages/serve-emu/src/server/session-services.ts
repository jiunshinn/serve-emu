import type { AccessibilitySnapshot } from "../accessibility.ts";
import type { ApplyLocationOptions } from "../api/dependencies.ts";
import { loadDeviceGrid } from "../device-grid.ts";
import type { DeviceSessionManager } from "../device-session-context.ts";
import type { RunningAvd } from "../emulator.ts";
import type { Gesture } from "../input.ts";
import type { GeoFix } from "../location.ts";
import { readJsonLimited } from "../request-body.ts";
import type { Device, DeviceGridResponse } from "../shared/api-contracts.ts";
import type { DeviceContext } from "./types.ts";

/**
 * Work the API routes and the WebSocket do against one device session. Each
 * checks the session around its work, so a request that outlives a device
 * switch fails with a 409 instead of acting on the new device.
 */
export function createSessionServices(deps: {
  sessions: DeviceSessionManager<DeviceContext>;
  maxJsonBodyBytes: number;
  loadAccessibility: (
    serial: string,
    signal: AbortSignal,
  ) => Promise<AccessibilitySnapshot>;
  setLocation: (
    serial: string,
    fix: GeoFix,
    signal: AbortSignal,
  ) => Promise<void>;
  listDevices: () => Promise<Device[]>;
  listAvds: () => Promise<string[]>;
  listRunningAvds: (devices: readonly Device[]) => Promise<RunningAvd[]>;
}) {
  const {
    sessions,
    maxJsonBodyBytes,
    loadAccessibility,
    setLocation,
    listDevices,
    listAvds,
    listRunningAvds,
  } = deps;

  const deviceGrid = async (
    context: DeviceContext,
  ): Promise<DeviceGridResponse> => {
    // One `adb devices` snapshot per request: running-AVD names resolve from
    // that same list, so the rows cannot disagree with each other.
    const grid = await loadDeviceGrid(context.serial, context.status, {
      listAllDevices: () => listDevices(),
      listAvds: () => listAvds(),
      resolveRunningAvds: (devices) => listRunningAvds(devices),
    });
    sessions.assertPublished(context);
    return grid;
  };

  const readJsonBody = async (
    req: Request,
    maxBytes = maxJsonBodyBytes,
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

  return {
    deviceGrid,
    readJsonBody,
    runForContext,
    runForPublishedContext,
    readAccessibilitySnapshot,
    enqueueGesture,
    applyLocation,
  };
}
