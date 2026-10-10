import {
  getFontScale,
  getNetworkStatus,
  getNightMode,
  getUserRotation,
  listScrcpySockets,
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
import type { AdbDeps } from "./adb-command.ts";
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
  /** Abstract socket names of the scrcpy sessions on the device, this server's included. */
  scrcpySockets(serial: string, signal: AbortSignal): Promise<string[]>;
};

export type DeviceServiceRunners = Pick<AdbDeps, "execText" | "execBuffer">;

export function createDeviceService(runners: DeviceServiceRunners = {}): DeviceService {
  // Every command a call runs is cancelled by that call's signal.
  const deps = (signal: AbortSignal): AdbDeps => ({ ...runners, signal });
  return {
    screenshot: (serial, signal) => screencapPng(serial, deps(signal)),
    foregroundApp: (serial, signal) => getForegroundApp(serial, deps(signal)),
    orientation: (serial, signal) => getUserRotation(serial, deps(signal)),
    setOrientation: (serial, mode, signal) => setUserRotation(serial, mode, deps(signal)),
    nightMode: (serial, signal) => getNightMode(serial, deps(signal)),
    setNightMode: (serial, mode, signal) => setNightMode(serial, mode, deps(signal)),
    fontScale: (serial, signal) => getFontScale(serial, deps(signal)),
    setFontScale: (serial, scale, signal) => setFontScale(serial, scale, deps(signal)),
    network: (serial, signal) => getNetworkStatus(serial, deps(signal)),
    setNetwork: (serial, enabled, signal) => setNetworkEnabled(serial, enabled, deps(signal)),
    launchApp: (serial, packageName, activity, signal) =>
      launchApp(serial, packageName, activity, deps(signal)),
    clearAppData: (serial, packageName, signal) =>
      clearAppData(serial, packageName, deps(signal)),
    forceStopApp: (serial, packageName, signal) =>
      forceStopApp(serial, packageName, deps(signal)),
    grantPermission: (serial, packageName, permission, signal) =>
      grantPermission(serial, packageName, permission, deps(signal)),
    scrcpySockets: (serial, signal) => listScrcpySockets(serial, deps(signal)),
  };
}
