import {
  getFontScale,
  getNetworkStatus,
  getNightMode,
  getUserRotation,
  screencapPng,
  setFontScale,
  setNetworkEnabled,
  setNightMode,
  setUserRotation,
} from "./adb.ts";
import { getForegroundApp } from "./app-info.ts";
import {
  clearAppData,
  forceStopApp,
  grantPermission,
  launchApp,
} from "./app-management.ts";
import { execBuffer, execText, type ExecOpts } from "./exec.ts";
import type {
  AppActionResponse,
  FontScaleStatus,
  ForegroundApp,
  NetworkStatus,
  NightMode,
  NightModeStatus,
  OrientationMode,
  OrientationStatus,
} from "./shared/api-contracts.ts";

/**
 * The device commands the API routes run. Every call takes the signal of the
 * request's device session, so a device switch (or a client disconnect) kills
 * the adb process instead of letting it run to its timeout.
 */
export type DeviceService = {
  screenshot(serial: string, signal: AbortSignal): Promise<Buffer>;
  foregroundApp(serial: string, signal: AbortSignal): Promise<ForegroundApp>;
  orientation(serial: string, signal: AbortSignal): Promise<OrientationStatus>;
  setOrientation(serial: string, mode: OrientationMode, signal: AbortSignal): Promise<OrientationStatus>;
  nightMode(serial: string, signal: AbortSignal): Promise<NightModeStatus>;
  setNightMode(serial: string, mode: NightMode, signal: AbortSignal): Promise<NightModeStatus>;
  fontScale(serial: string, signal: AbortSignal): Promise<FontScaleStatus>;
  setFontScale(serial: string, scale: number, signal: AbortSignal): Promise<FontScaleStatus>;
  network(serial: string, signal: AbortSignal): Promise<NetworkStatus>;
  setNetwork(serial: string, enabled: boolean, signal: AbortSignal): Promise<NetworkStatus>;
  launchApp(serial: string, packageName: string, activity: string | undefined, signal: AbortSignal): Promise<AppActionResponse>;
  clearAppData(serial: string, packageName: string, signal: AbortSignal): Promise<AppActionResponse>;
  forceStopApp(serial: string, packageName: string, signal: AbortSignal): Promise<AppActionResponse>;
  grantPermission(serial: string, packageName: string, permission: string, signal: AbortSignal): Promise<AppActionResponse>;
};

export type DeviceServiceRunners = {
  execText?: typeof execText;
  execBuffer?: typeof execBuffer;
};

/** An exec runner that adds `signal` to every command it runs. */
function withSignal<Run extends typeof execText | typeof execBuffer>(
  run: Run,
  signal: AbortSignal,
): Run {
  return ((cmd: string, args: string[], opts: ExecOpts = {}) =>
    run(cmd, args, { ...opts, signal })) as Run;
}

export function createDeviceService(runners: DeviceServiceRunners = {}): DeviceService {
  const text = runners.execText ?? execText;
  const buffer = runners.execBuffer ?? execBuffer;
  const textFor = (signal: AbortSignal) => withSignal(text, signal);
  return {
    screenshot: (serial, signal) => screencapPng(serial, withSignal(buffer, signal)),
    foregroundApp: (serial, signal) => getForegroundApp(serial, textFor(signal)),
    orientation: (serial, signal) => getUserRotation(serial, textFor(signal)),
    setOrientation: (serial, mode, signal) => setUserRotation(serial, mode, textFor(signal)),
    nightMode: (serial, signal) => getNightMode(serial, textFor(signal)),
    setNightMode: (serial, mode, signal) => setNightMode(serial, mode, textFor(signal)),
    fontScale: (serial, signal) => getFontScale(serial, textFor(signal)),
    setFontScale: (serial, scale, signal) => setFontScale(serial, scale, textFor(signal)),
    network: (serial, signal) => getNetworkStatus(serial, textFor(signal)),
    setNetwork: (serial, enabled, signal) => setNetworkEnabled(serial, enabled, textFor(signal)),
    launchApp: (serial, packageName, activity, signal) =>
      launchApp(serial, packageName, activity, { execText: textFor(signal) }),
    clearAppData: (serial, packageName, signal) =>
      clearAppData(serial, packageName, { execText: textFor(signal) }),
    forceStopApp: (serial, packageName, signal) =>
      forceStopApp(serial, packageName, { execText: textFor(signal) }),
    grantPermission: (serial, packageName, permission, signal) =>
      grantPermission(serial, packageName, permission, { execText: textFor(signal) }),
  };
}
